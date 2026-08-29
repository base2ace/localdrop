using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class Launcher {
    static void Main() {
        string appDir = AppDomain.CurrentDomain.BaseDirectory;
        string serverPath = Path.Combine(appDir, "server.js");

        if (!File.Exists(serverPath)) {
            Console.WriteLine("Error: server.js not found in " + appDir);
            Console.ReadLine();
            return;
        }

        Console.WriteLine("========================================================");
        Console.WriteLine("            LocalDrop Server Launcher                  ");
        Console.WriteLine("========================================================\n");
        Console.WriteLine("Starting LocalDrop Node.js Server...");

        ProcessStartInfo startInfo = new ProcessStartInfo {
            FileName = "node",
            Arguments = "server.js",
            WorkingDirectory = appDir,
            UseShellExecute = false,
            CreateNoWindow = false
        };

        try {
            Process process = Process.Start(startInfo);
            Console.WriteLine("Server started successfully!");
            Thread.Sleep(2500); // Wait for ports to bind and generate certificates
            Process.Start("http://localhost:3000"); // Open browser
            process.WaitForExit();
        } catch (Exception ex) {
            Console.WriteLine("Error starting server: " + ex.Message);
            Console.WriteLine("Please ensure Node.js is installed and added to PATH.");
            Console.ReadLine();
        }
    }
}
