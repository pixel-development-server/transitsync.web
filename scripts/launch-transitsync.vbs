' ===========================================================================
'  TransitSync desktop launcher
'
'  Behaviour:
'
'    * If the API is not already running it is started in a VISIBLE server
'      console so the operator can watch live logs. Closing that console
'      stops the server and takes the web panel offline for every device.
'    * The console is then opened in browser "app mode" -- a chromeless
'      window with no tabs or address bar -- so it looks like native software.
'
'  Invoked by the "TransitSync" desktop shortcut through wscript.exe.
' ===========================================================================
Option Explicit

Dim fso, shell, appDir, serverDir, clientDir, distIndex
Dim url, health, logPath
Dim ready, i, browser, cmd, tail

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' This script lives at <app>\scripts\launch-transitsync.vbs
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
serverDir = fso.BuildPath(appDir, "server")
clientDir = fso.BuildPath(appDir, "client")
distIndex = fso.BuildPath(clientDir, "dist\index.html")
logPath = fso.BuildPath(serverDir, "launcher.log")

url = "http://localhost:8080"
health = "http://127.0.0.1:8080/api/health"

' --- Sanity check ----------------------------------------------------------
If Not fso.FileExists(fso.BuildPath(serverDir, "src\index.js")) Then
  MsgBox "Cannot find the TransitSync server at:" & vbCrLf & serverDir, _
         vbCritical, "TransitSync"
  WScript.Quit 1
End If

' --- First run: the web console still needs to be built --------------------
' Defer to the batch launcher, which shows the build progress in a window.
If Not fso.FileExists(distIndex) Then
  shell.Run """" & fso.BuildPath(appDir, "start-transitsync.bat") & """", 1, False
  WScript.Quit 0
End If

' --- Start the API if it is not already listening --------------------------
' The server runs in a VISIBLE console window so the operator can watch live
' logs. Closing that window stops the server and takes the web panel offline.
If Not IsHealthy(health) Then
  cmd = "cmd /c """ & fso.BuildPath(appDir, "start-transitsync-console.bat") & """"
  shell.Run cmd, 1, False

  ready = False
  For i = 1 To 120
    WScript.Sleep 500
    If IsHealthy(health) Then
      ready = True
      Exit For
    End If
  Next

  If Not ready Then
    MsgBox "TransitSync did not start within 60 seconds." & vbCrLf & vbCrLf & _
           "Check the 'TransitSync Server' console window for the error.", _
           vbCritical, "TransitSync"
    WScript.Quit 1
  End If
End If

' --- Open the console as an app window -------------------------------------
browser = FindBrowser(fso, shell)
If browser <> "" Then
  shell.Run """" & browser & """ --app=" & url & " --window-size=1500,950", 1, False
Else
  shell.Run url, 1, False
End If

WScript.Quit 0

' --- Helpers ---------------------------------------------------------------
Function IsHealthy(u)
  On Error Resume Next
  Dim http
  IsHealthy = False
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1500, 1500, 1500, 2000
  http.open "GET", u, False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then IsHealthy = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function FindBrowser(f, s)
  Dim pf, pf86, lad, candidates, j
  pf = s.ExpandEnvironmentStrings("%ProgramFiles%")
  pf86 = s.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
  lad = s.ExpandEnvironmentStrings("%LOCALAPPDATA%")

  candidates = Array( _
    pf & "\Google\Chrome\Application\chrome.exe", _
    pf86 & "\Google\Chrome\Application\chrome.exe", _
    lad & "\Google\Chrome\Application\chrome.exe", _
    pf & "\Microsoft\Edge\Application\msedge.exe", _
    pf86 & "\Microsoft\Edge\Application\msedge.exe")

  For j = 0 To UBound(candidates)
    If f.FileExists(candidates(j)) Then
      FindBrowser = candidates(j)
      Exit Function
    End If
  Next
  FindBrowser = ""
End Function

Function TailLines(path, n)
  On Error Resume Next
  Dim ts, all, lines, start, k, out
  Set ts = fso.OpenTextFile(path, 1)
  all = ts.ReadAll
  ts.Close
  lines = Split(all, vbCrLf)
  start = UBound(lines) - n + 1
  If start < 0 Then start = 0
  out = ""
  For k = start To UBound(lines)
    out = out & lines(k) & vbCrLf
  Next
  TailLines = out
  On Error GoTo 0
End Function
