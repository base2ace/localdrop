Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node server.js", 0, false
WScript.Sleep 2500
WshShell.Run "http://localhost:3000", 9
