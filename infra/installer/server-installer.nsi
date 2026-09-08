; NSIS script for the isthislegit server installer.
;
; Same toolchain the desktop client already ships with (electron-builder wraps
; NSIS), so both halves of the project hand over the same kind of artifact: one
; setup.exe, solid LZMA, an uninstaller and an Add/Remove Programs entry.
;
; It is not compiled by hand. build-server-installer.ps1 stages the payload and
; calls makensis with the defines below:
;
;   PAYLOAD    folder holding server\ shared\ console\ livekit\ install.ps1
;   VERSION    e.g. 0.1.0
;   VERSION4   the same as four parts, e.g. 0.1.0.0 (VIProductVersion demands it)
;   OUTFILE    full path of the .exe to write
;   PAYLOADMB  unpacked size of the payload in MB, for the free space check
;
; One .exe, two behaviours. Run against a box with no server on it, this
; installs one. Run against a box that already has one, it updates it instead:
; the config pages are skipped, the payload is unpacked beside the running
; server rather than over it, and install.ps1 -Update replaces only the
; components whose contents actually changed and restarts only the services
; that read them. See "the update path" in install.ps1.

Unicode true

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
; For the welcome and finish page text, which says different things on an
; update and cannot be a compile-time define because of it.
!include "WinMessages.nsh"

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
; Unpacked size of the payload, in MB. Checked against the free space on the
; target volume before anything is written, because the payload is now unpacked
; beside the install rather than over it -- an update needs room for both at
; once, and running out halfway is the one failure that would leave a stopped
; server and a half-written tree.
!ifndef PAYLOADMB
  !define PAYLOADMB 800
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

; "1" when there is already an install in $INSTDIR. Set in .onInit, and the one
; thing that decides whether this runs as an installer or as an updater.
Var IsUpgrade
Var OldVersion

; ---------------------------------------------------------------------- pages

!define MUI_ABORTWARNING
; BMP-encoded entries only, and nothing above 64px: makensis rejects the
; PNG-compressed sizes an .ico for the app itself would carry.
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_WELCOMEPAGE_TITLE "isthislegit server ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This installs the chat server, the operator console and LiveKit on this machine.$\r$\n$\r$\nBefore you continue, make sure this box has:$\r$\n    Node.js 22 or newer$\r$\n    PostgreSQL 17 running as a service$\r$\n$\r$\nRe-running this installer upgrades in place. Your database, your .env and your LiveKit keys are kept."
; The welcome and finish text above is the fresh-install wording. On an update
; both are rewritten at runtime -- see WelcomePageShow and FinishPageShow --
; because a define is fixed at compile time and this one .exe has to be able to
; say either thing.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomePageShow
!insertmacro MUI_PAGE_WELCOME

; Where the files go is already settled on an update, and offering to change it
; would only be offering to install a second copy somewhere else by accident.
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipOnUpgrade
!insertmacro MUI_PAGE_DIRECTORY

Page custom ConfigPageShow ConfigPageLeave
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_FINISHPAGE_TEXT "The server is installed.$\r$\n$\r$\nThe invite code the first account needs was written to invite-code.txt in the install folder. The first person to register with it becomes the admin.$\r$\n$\r$\nIf you left 'start on boot' ticked, the server and LiveKit come up on their own after a restart."
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\invite-code.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open invite-code.txt"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageShow
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ----------------------------------------------------------------- custom page

Function SkipOnUpgrade
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}
FunctionEnd

Function WelcomePageShow
  ${If} $IsUpgrade != 1
    Return
  ${EndIf}
  SendMessage $mui.WelcomePage.Title ${WM_SETTEXT} 0 "STR:Updating isthislegit server"
  SendMessage $mui.WelcomePage.Text ${WM_SETTEXT} 0 "STR:$OldVersion is installed in $INSTDIR. This updates it to ${VERSION}.$\r$\n$\r$\nOnly the parts that actually changed are replaced, and only the services that read them are restarted -- if the LiveKit binary has not changed, calls in progress are not interrupted.$\r$\n$\r$\nThe new version is unpacked alongside the old one first, so the server keeps serving until the swap at the end. Expect it to be unreachable for a few seconds.$\r$\n$\r$\nYour database, server\.env, your LiveKit keys and everything in data\ are kept. If the server does not come back, the previous version is put back automatically."
FunctionEnd

Function FinishPageShow
  ${If} $IsUpgrade != 1
    Return
  ${EndIf}
  SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:The server is updated to ${VERSION} and answering again.$\r$\n$\r$\nThe details list above says which components were replaced, which services were restarted, and how long the server was down for.$\r$\n$\r$\nThere is no new invite code: the accounts and the guild are the ones that were already here."
  ; No new invite code on an update, so the checkbox offering to open the file
  ; would open the one the first install wrote months ago.
  ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
FunctionEnd

Function ConfigPageShow
  ; Every answer this page collects is already recorded in server\.env and
  ; livekit\livekit.yaml. Asking again on an update is not a chance to confirm
  ; them, it is a chance to change one by accident -- and a changed LAN address
  ; presents as voice connecting and staying silent.
  ${If} $IsUpgrade == 1
    Abort
  ${EndIf}

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
  StrCpy $IsUpgrade "0"

  ; Installer or updater? InstallDirRegKey has already pointed $INSTDIR at any
  ; recorded install by the time this runs, so the question is only whether a
  ; server is actually sitting there.
  ;
  ; The file and not the registry key decides it. A key can outlive the folder
  ; somebody deleted by hand, and answering "update" to an empty directory would
  ; mean install.ps1 refusing to run with nothing installed. A key can also be
  ; missing from an install made before it was written, and answering "fresh" to
  ; a live server is the far worse mistake -- that is the case that unpacks over
  ; a running process.
  IfFileExists "$INSTDIR\server\dist\main.js" 0 onInitFresh
    StrCpy $IsUpgrade "1"
    ReadRegStr $OldVersion HKLM "Software\isthislegit\server" "Version"
    ${If} $OldVersion == ""
      StrCpy $OldVersion "An earlier version"
    ${Else}
      StrCpy $OldVersion "Version $OldVersion"
    ${EndIf}
    ; Nothing below this point is asked for on an update.
    Return
  onInitFresh:

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

  ; The payload is unpacked beside the install, never over it, so an update
  ; needs room for both at once. Finding that out after 617 MB is on the disk
  ; and the server is stopped is the worst possible time to find it out.
  ${GetRoot} "$INSTDIR" $0
  ${DriveSpace} "$0\" "/D=F /S=M" $1
  ${If} $1 < ${PAYLOADMB}
    MessageBox MB_ICONSTOP "There is not enough room on $0 to unpack this.$\r$\n$\r$\n    free    $1 MB$\r$\n    needed  ${PAYLOADMB} MB$\r$\n$\r$\nNothing has been changed."
    Abort
  ${EndIf}

  ; Everything unpacks into .update, on both paths.
  ;
  ; It used to go straight into $INSTDIR, which could not work over a running
  ; server and was never really tried: node holds the Prisma query engine open,
  ; LiveKit and the admin app hold their own executables, and the first locked
  ; file aborts the section with an error about opening a file for writing.
  ;
  ; Unpacking beside it instead is what makes a short update possible. The slow
  ; part -- six hundred megabytes and thirty thousand files -- happens with the
  ; old version still serving, and install.ps1 then renames the few directories
  ; that actually changed into place. On a fresh install it renames all of them,
  ; which within one volume costs nothing.
  DetailPrint "Unpacking..."
  RMDir /r "$INSTDIR\.update"
  SetOutPath "$INSTDIR\.update"
  File /r "${PAYLOAD}\*.*"

  ; On a fresh install, put install.ps1 at the root now rather than relying on
  ; install.ps1 to put itself there. If it fails before it gets that far -- a
  ; missing prerequisite, a Node too old -- the staging folder is deleted below
  ; and the recovery instructions in the failure message would otherwise name a
  ; file that is not there. Not done on an update: the installed copy is the
  ; old version's until this one has actually worked, and a rollback has to be
  ; able to leave it that way.
  ${If} $IsUpgrade != 1
    CopyFiles /SILENT "$INSTDIR\.update\install.ps1" "$INSTDIR"
  ${EndIf}

  ; --- registry, uninstaller, Add/Remove Programs -------------------------
  ; Version is deliberately not written here. It is a claim about what is
  ; installed and running, and at this point nothing has been swapped in or
  ; started -- install.ps1 writes it once the server has answered /api/health.
  WriteRegStr HKLM "Software\isthislegit\server" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"     "isthislegit server"
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ; --- configure, or update -----------------------------------------------
  ; install.ps1 owns every decision that is not "where do the files go":
  ; the database role, the generated secrets, the LiveKit config, migrations,
  ; the seed and the boot registration. It runs -NonInteractive because there
  ; is no console here to prompt on; the answers come from the page above.
  ;
  ; It is run out of .update on both paths, and it is the copy that was just
  ; unpacked -- so the logic that decides how to update is always the new
  ; version's, not the one the previous release happened to leave behind.

  StrCpy $2 '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\.update\install.ps1" -InstallDir "$INSTDIR" -NonInteractive'

  ${If} $IsUpgrade == 1
    DetailPrint "Updating the server..."
    ; No -LanIp, no -PostgresPassword and no -NoStartup: the database role
    ; exists, the tasks are registered, and the addresses are in server\.env
    ; and livekit\livekit.yaml already. Passing them again could only change
    ; something nobody asked to change.
    StrCpy $2 '$2 -Update'
  ${Else}
    DetailPrint "Configuring the server..."
    ${If} $LanIp != ""
      StrCpy $2 '$2 -LanIp "$LanIp"'
    ${EndIf}
    ${If} $PgPassword != ""
      StrCpy $2 '$2 -PostgresPassword "$PgPassword"'
    ${EndIf}
    ${If} $StartOnBoot != ${BST_CHECKED}
      StrCpy $2 '$2 -NoStartup'
    ${EndIf}
  ${EndIf}

  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" $2'
  Pop $3

  ; The staging folder is not wanted either way. A fresh install has renamed
  ; everything out of it; an update has taken the components it needed and left
  ; the rest, and a retry re-unpacks from this same .exe anyway.
  DetailPrint "Cleaning up..."
  RMDir /r "$INSTDIR\.update"

  ${If} $3 == 0
    ; Only now is the version a true statement about what is installed and
    ; running. On the update path install.ps1 has already waited for
    ; /api/health, and rolled back to the old version if it never came.
    WriteRegStr HKLM "Software\isthislegit\server" "Version" "${VERSION}"
    WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $0
  ${ElseIf} $IsUpgrade == 1
    DetailPrint "Update failed (exit $3)."
    MessageBox MB_ICONEXCLAMATION "The update failed (exit $3), and the previous version was put back.$\r$\n$\r$\nRead the details list for the reason. Nothing was left half-applied, with one exception: a migration that had already run is still applied, because Prisma has no down migrations.$\r$\n$\r$\nThe server should be answering again on the version it was on before. Check the details list to be sure."
  ${Else}
    DetailPrint "Configuration failed (exit $3)."
    MessageBox MB_ICONEXCLAMATION "The files are installed, but the configuration step failed (exit $3).$\r$\n$\r$\nRead the details list for the reason -- a wrong postgres password and a stopped database service are the usual two. Then fix it and re-run, from an elevated PowerShell:$\r$\n$\r$\npowershell -ExecutionPolicy Bypass -File $\"$INSTDIR\install.ps1$\""
  ${EndIf}
SectionEnd

; ------------------------------------------------------------------- uninstall

Var KeepData

Function un.onInit
  StrCpy $KeepData "1"
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Keep your configuration and uploaded files?$\r$\n$\r$\nYes  - server\.env and the data\ folder (uploads, published builds) are left behind$\r$\nNo   - everything in the install folder is removed$\r$\n$\r$\nEither way the PostgreSQL 'chat' database is NOT touched. Drop it by hand if you want the messages gone." \
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
  RMDir /r "$INSTDIR\app"
  Delete "$SMPROGRAMS\isthislegit Server.lnk"
  Delete "$DESKTOP\isthislegit Server.lnk"
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
  Delete "$INSTDIR\payload.json"
  Delete "$INSTDIR\installed.json"

  ; Both are staging areas an update uses and removes itself. They only exist
  ; here if one was interrupted, and neither holds anything the install needs.
  RMDir /r "$INSTDIR\.update"
  RMDir /r "$INSTDIR\.rollback"

  Delete "$INSTDIR\uninstall.exe"

  ${If} $KeepData == "0"
    DetailPrint "Removing configuration and uploads..."
    Delete "$INSTDIR\server\.env"
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\server"
    RMDir /r "$INSTDIR"
  ${Else}
    DetailPrint "Kept server\.env and the data\ folder."
    RMDir "$INSTDIR\server"
    RMDir "$INSTDIR"
  ${EndIf}

  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "Software\isthislegit\server"
SectionEnd
