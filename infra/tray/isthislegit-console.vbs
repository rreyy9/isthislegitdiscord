' Opens the operator console as an app window.
'
' Double click this. It starts the console if it is not already running, waits
' for it to answer, and opens it in a chromeless browser window -- no address
' bar, no tabs, its own taskbar entry. As close to a native app as this gets
' without shipping a second Electron build for the server side.
'
' The console does not need the chat server running: it is the thing that
' starts the chat server, and its Configuration tab works with everything
' stopped. That is the point of it being a separate process.
'
' Edge is used because it is present on every supported Windows and takes
' --app=. Chrome is tried second. If neither is found the default browser gets
' it as an ordinary tab, which works, just less tidily.

Option Explicit

Dim shell, fso, here, url, i, ok, browser
Dim consoleDir, launchCmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:4000"

' Two layouts. In the repo this sits at infra\tray and the console is at
' apps\console; in an installed copy it sits at <install>\tray and the console
' is at <install>\console. Detect rather than assume -- an installed console
' also has no npm workspace around it, so it is started differently.
consoleDir = ""
If fso.FileExists(Up(2, here) & "\apps\console\src\main.mjs") Then
    consoleDir = Up(2, here) & "\apps\console"
    launchCmd = "cmd /c npm run console"
ElseIf fso.FileExists(Up(1, here) & "\console\src\main.mjs") Then
    consoleDir = Up(1, here) & "\console"
    ' No workspace to run an npm script from: call node directly.
    launchCmd = "cmd /c node src\main.mjs"
End If

' Already up? Then just open it. Starting a second console would fail on the
' port bind and leave a window explaining that instead of the console.
If Not ConsoleIsUp() Then
    If consoleDir = "" Then
        MsgBox "Could not find the operator console next to this file." & vbCrLf & vbCrLf & _
               "Looked in:" & vbCrLf & _
               "  " & Up(2, here) & "\apps\console" & vbCrLf & _
               "  " & Up(1, here) & "\console", vbExclamation, "isthislegit"
        WScript.Quit 1
    End If

    ' Hidden: the console's own output goes to its Logs tab, so a console
    ' window here would only be something to accidentally close.
    shell.CurrentDirectory = consoleDir
    shell.Run launchCmd, 0, False

    ' Up to about twenty seconds. npm's own startup dominates this.
    ok = False
    For i = 1 To 40
        WScript.Sleep 500
        If ConsoleIsUp() Then
            ok = True
            Exit For
        End If
    Next

    If Not ok Then
        MsgBox "The console did not start within 20 seconds." & vbCrLf & vbCrLf & _
               "Run it by hand in " & consoleDir & " to see why.", vbExclamation, "isthislegit"
        WScript.Quit 1
    End If
End If

browser = FindBrowser()
If browser = "" Then
    shell.Run url, 1, False
Else
    shell.Run """" & browser & """ --app=" & url, 1, False
End If

' ---------------------------------------------------------------- helpers

' n folders up from p.
Function Up(n, p)
    Dim k
    Up = p
    For k = 1 To n
        Up = fso.GetParentFolderName(Up)
    Next
End Function

' A request rather than a port scan: the console answering on 4000 is what we
' actually care about, and WinHTTP is on every Windows without anything added.
Function ConsoleIsUp()
    Dim http
    ConsoleIsUp = False
    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    If Err.Number <> 0 Then Exit Function
    http.SetTimeouts 800, 800, 800, 1500
    http.Open "GET", "http://127.0.0.1:4000/sv/status", False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then ConsoleIsUp = True
    On Error GoTo 0
End Function

Function FindBrowser()
    Dim candidates, p
    candidates = Array( _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"))
    FindBrowser = ""
    For Each p In candidates
        If fso.FileExists(p) Then
            FindBrowser = p
            Exit Function
        End If
    Next
End Function
