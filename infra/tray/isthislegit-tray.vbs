' Double click this to put the isthislegit tray icon in the notification area.
'
' Why a .vbs and not a .cmd or a shortcut to the .ps1: both of those flash a
' console window on the way past, and a .ps1 double clicked in Explorer opens
' in Notepad rather than running. WScript.Shell.Run with a window style of 0 is
' the only way on stock Windows to start a PowerShell script with no window at
' all and nothing left behind.
'
' To start it with Windows, put a shortcut to this file in:
'   shell:startup

Option Explicit

Dim shell, fso, here, script

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "tray.ps1")

If Not fso.FileExists(script) Then
    MsgBox "tray.ps1 was not found next to this file." & vbCrLf & vbCrLf & _
           "Expected: " & script, vbExclamation, "isthislegit"
    WScript.Quit 1
End If

' powershell.exe rather than pwsh: Windows PowerShell 5.1 is always present and
' runs single threaded apartment by default, which WinForms requires. pwsh
' defaults to MTA and the tray icon would never appear.
'
' 0 = hidden window, False = do not wait for it to exit.
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
