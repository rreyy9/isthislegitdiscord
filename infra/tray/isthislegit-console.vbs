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

Dim shell, fso, here, repo, url, i, ok, browser

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
repo = fso.GetParentFolderName(fso.GetParentFolderName(here))
url = "http://127.0.0.1:4000"

' Already up? Then just open it. Starting a second console would fail on the
' port bind and leave a window explaining that instead of the console.
If Not ConsoleIsUp() Then
    If Not fso.FileExists(fso.BuildPath(repo, "apps\console\src\main.mjs")) Then
        MsgBox "Could not find the console at:" & vbCrLf & vbCrLf & _
               fso.BuildPath(repo, "apps\console\src\main.mjs"), vbExclamation, "isthislegit"
        WScript.Quit 1
    End If

    ' Hidden: the console's own output goes to its Logs tab, so a console
    ' window here would only be something to accidentally close.
    shell.CurrentDirectory = repo
    shell.Run "cmd /c npm run console", 0, False

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
               "Run 'npm run console' in " & repo & " to see why.", vbExclamation, "isthislegit"
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
