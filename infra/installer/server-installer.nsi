; NSIS script for the isthislegit server installer.
;
; Same toolchain the desktop client already ships with (electron-builder wraps
; NSIS), so both halves of the project hand over the same kind of artifact: one
; setup.exe, solid LZMA, an uninstaller and an Add/Remove Programs entry.
;
; It is not compiled by hand. build-server-installer.ps1 stages the payload and
; calls makensis with the defines below:
;
;   PAYLOAD   folder holding server\ shared\ console\ livekit\ install.ps1
;   VERSION   e.g. 0.1.0
;   VERSION4  the same as four parts, e.g. 0.1.0.0 (VIProductVersion demands it)
;   OUTFILE   full path of the .exe to write

Unicode true

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"

!ifndef PAYLOAD
  !error "PAYLOAD is not defined. Build this with build-server-installer.ps1."
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VERSION4
  !define VERSION4 "${VERSION}.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "isthislegit-server-${VERSION}-setup.exe"
!endif

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\isthislegit-server"

Name "isthislegit server ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "C:\isthislegit"
InstallDirRegKey HKLM "Software\isthislegit\server" "InstallDir"

; The install writes to Program Files-class locations, creates a scheduled task
; and talks to the Postgres service. All of that needs administrator.
RequestExecutionLevel admin

; Solid LZMA. The payload is mostly node_modules -- tens of thousands of small
; files -- and this is the difference between a fast install and the several
; minutes a plain zip takes to extract in Explorer.
SetCompressor /SOLID lzma

ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName"     "isthislegit server"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "FileDescription" "isthislegit chat and voice server"
VIAddVersionKey "LegalCopyright"  ""

Var Dialog
Var LanIpField
Var PgPassField
Var BootCheckbox
Var LanIp
Var PgPassword
Var StartOnBoot

; ---------------------------------------------------------------------- pages

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "isthislegit server ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This installs the chat server, the operator console and LiveKit on this machine.$\r$\n$\r$\nBefore you continue, make sure this box has:$\r$\n    Node.js 22 or newer$\r$\n    PostgreSQL 17 running as a service$\r$\n$\r$\nRe-running this installer upgrades in place. Your database, your .env and your LiveKit keys are kept."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom ConfigPageShow ConfigPageLeave
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_TEXT "The server is installed.$\r$\n$\r$\nThe invite code the first account needs was written to invite-code.txt in the install folder. The first person to register with it becomes the admin.$\r$\n$\r$\nIf you left 'start on boot' ticked, the server and LiveKit come up on their own after a restart."
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\invite-code.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open invite-code.txt"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ----------------------------------------------------------------- custom page

Function ConfigPageShow
  !insertmacro MUI_HEADER_TEXT "Server settings" "How this machine is reached, and how to set the database up."

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "LAN address other machines reach this box on. LiveKit has to advertise it explicitly -- if it picks the wrong interface, calls connect and no audio ever arrives. Leave blank to detect it."
  Pop $0
  ${NSD_CreateText} 0 28u 100% 12u "$LanIp"
  Pop $LanIpField

  ${NSD_CreateLabel} 0 48u 100% 26u "postgres superuser password. Used once, to create the chat_app role and the chat database. Leave it blank if that is already done, or to do it by hand later."
  Pop $0
  ${NSD_CreatePassword} 0 76u 100% 12u ""
  Pop $PgPassField

  ${NSD_CreateCheckbox} 0 98u 100% 10u "Start the server and LiveKit on boot"
  Pop $BootCheckbox
  ${If} $StartOnBoot == ${BST_CHECKED}
    ${NSD_Check} $BootCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0 112u 100% 20u "Everything here can be changed afterwards in server\.env and livekit\livekit.yaml."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function ConfigPageLeave
  ${NSD_GetText}  $LanIpField   $LanIp
  ${NSD_GetText}  $PgPassField  $PgPassword
  ${NSD_GetState} $BootCheckbox $StartOnBoot
FunctionEnd

; --------------------------------------------------------------------- install

Function .onInit
  StrCpy $StartOnBoot ${BST_CHECKED}

  ; Prefill the LAN address, as a suggestion only. Pick the interface that has a
  ; default gateway rather than the first IPv4: a dev box typically carries
  ; VirtualBox, Hyper-V and link-local addresses too, and on this project's own
  ; machine the first IPv4 is VirtualBox's 192.168.56.1 -- exactly the wrong
  ; answer, and one whose failure mode is a call that connects with no audio.
  ; If this fails the field is left empty and install.ps1 detects it the same way.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetIPConfiguration | Where-Object { $$_.IPv4DefaultGateway -and $$_.NetAdapter.Status -eq $\'Up$\' } | Select-Object -First 1).IPv4Address.IPAddress"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ${TrimNewLines} $1 $1
    StrCpy $LanIp $1
  ${EndIf}
FunctionEnd

Section "isthislegit server" SecServer
  SectionIn RO

  DetailPrint "Unpacking..."
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"

  ; --- registry, uninstaller, Add/Remove Programs -------------------------
  WriteRegStr HKLM "Software\isthislegit\server" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\isthislegit\server" "Version"    "${VERSION}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"     "isthislegit server"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $0

  ; --- configure ----------------------------------------------------------
  ; install.ps1 owns every decision that is not "where do the files go":
  ; the database role, the generated secrets, the LiveKit config, migrations,
  ; the seed and the boot registration. It runs -NonInteractive because there
  ; is no console here to prompt on; the answers come from the page above.
  DetailPrint "Configuring the server..."

  StrCpy $2 '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -InstallDir "$INSTDIR" -NonInteractive'
  ${If} $LanIp != ""
    StrCpy $2 '$2 -LanIp "$LanIp"'
  ${EndIf}
  ${If} $PgPassword != ""
    StrCpy $2 '$2 -PostgresPassword "$PgPassword"'
  ${EndIf}
  ${If} $StartOnBoot != ${BST_CHECKED}
    StrCpy $2 '$2 -NoStartup'
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" $2'
  Pop $3
  ${If} $3 != 0
    DetailPrint "Configuration failed (exit $3)."
    MessageBox MB_ICONEXCLAMATION "The files are installed, but the configuration step failed (exit $3).$\r$\n$\r$\nRead the details list for the reason -- a wrong postgres password and a stopped database service are the usual two. Then fix it and re-run, from an elevated PowerShell:$\r$\n$\r$\npowershell -ExecutionPolicy Bypass -File $\"$INSTDIR\install.ps1$\""
  ${EndIf}
SectionEnd

; ------------------------------------------------------------------- uninstall

Var KeepData

Function un.onInit
  StrCpy $KeepData "1"
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Keep your configuration and uploaded files?$\r$\n$\r$\nYes  - server\.env and data\uploads are left behind$\r$\nNo   - everything in the install folder is removed$\r$\n$\r$\nEither way the PostgreSQL 'chat' database is NOT touched. Drop it by hand if you want the messages gone." \
    IDYES keep
  StrCpy $KeepData "0"
  keep:
FunctionEnd

Section "Uninstall"
  ; Stop and unregister the boot tasks first, so nothing is holding a file open
  ; or restarting itself while the folder is being deleted.
  DetailPrint "Removing scheduled tasks..."
  nsExec::ExecToLog 'schtasks /End /TN "isthislegit-server"'
  nsExec::ExecToLog 'schtasks /Delete /TN "isthislegit-server" /F'
  nsExec::ExecToLog 'schtasks /End /TN "isthislegit-livekit"'
  nsExec::ExecToLog 'schtasks /Delete /TN "isthislegit-livekit" /F'
  nsExec::ExecToLog 'schtasks /End /TN "isthislegit-caddy"'
  nsExec::ExecToLog 'schtasks /Delete /TN "isthislegit-caddy" /F'

  DetailPrint "Removing program files..."
  RMDir /r "$INSTDIR\server\dist"
  RMDir /r "$INSTDIR\server\node_modules"
  RMDir /r "$INSTDIR\server\prisma"
  RMDir /r "$INSTDIR\shared"
  RMDir /r "$INSTDIR\console"
  RMDir /r "$INSTDIR\livekit"
  RMDir /r "$INSTDIR\caddy"
  ; Kept although nothing ships a tray\ folder any more: an install made
  ; before the isthislegit Server app replaced it still has one, and an
  ; uninstall should not leave it behind.
  RMDir /r "$INSTDIR\tray"
  Delete "$INSTDIR\server\package.json"
  Delete "$INSTDIR\server\package-lock.json"
  Delete "$INSTDIR\server\prisma7.config.ts"
  Delete "$INSTDIR\server\.env.example"
  Delete "$INSTDIR\install.ps1"
  Delete "$INSTDIR\allow-lan.ps1"
  Delete "$INSTDIR\start-all.ps1"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\invite-code.txt"
  Delete "$INSTDIR\uninstall.exe"

  ${If} $KeepData == "0"
    DetailPrint "Removing configuration and uploads..."
    Delete "$INSTDIR\server\.env"
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\server"
    RMDir /r "$INSTDIR"
  ${Else}
    DetailPrint "Kept server\.env and data\uploads."
    RMDir "$INSTDIR\server"
    RMDir "$INSTDIR"
  ${EndIf}

  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "Software\isthislegit\server"
SectionEnd
