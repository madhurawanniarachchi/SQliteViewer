// SQLite Viewer - ADB bridge (Windows)
//
// Lets the SQLite Viewer web page talk to the ADB server that already runs on this
// computer (for example the one started by Android Studio), so both can use the phone
// at the same time.
//
// It is a plain relay:  WebSocket (browser)  <->  TCP 127.0.0.1:5037 (ADB server).
// It listens on this computer only (127.0.0.1) and only accepts connections from the
// websites that are allowed. Nothing is stored or sent anywhere else.
//
// Options:  --port N   --allow-origin URL (repeatable)   --origins-file PATH
// Extra allowed origins may also be listed, one per line, in origins.txt next to the program.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SqliteViewerBridge
{
    internal static class Program
    {
        private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        private const int MaxFrame = 64 * 1024 * 1024;
        private const int MaxHeader = 16 * 1024;

        private static readonly HashSet<string> Origins = new HashSet<string>(StringComparer.Ordinal);
        private static string adbHost = "127.0.0.1";
        private static int adbPort = 5037;
        private static int listenPort = 5038;
        private static string logPath;
        private static readonly object LogLock = new object();

        private static int Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            logPath = Path.Combine(baseDir, "bridge.log");
            Origins.Add("https://sqliteviewer.codemasterlk.com");

            try
            {
                ParseArguments(args, baseDir);
            }
            catch (Exception error)
            {
                Log("Bad arguments: " + error.Message);
                return 2;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\SQLiteViewerAdbBridge_" + listenPort, out created))
            {
                if (!created) return 0; // already running

                try
                {
                    Serve().GetAwaiter().GetResult();
                    return 0;
                }
                catch (SocketException error)
                {
                    Log("Cannot listen on 127.0.0.1:" + listenPort + " (" + error.Message + ")");
                    return 4;
                }
                catch (Exception error)
                {
                    Log("Stopped: " + error);
                    return 1;
                }
            }
        }

        private static void ParseArguments(string[] args, string baseDir)
        {
            string originsFile = Path.Combine(baseDir, "origins.txt");

            for (int i = 0; i < args.Length; i++)
            {
                string name = args[i];

                if (name == "--port" && i + 1 < args.Length) listenPort = int.Parse(args[++i]);
                else if (name == "--adb-port" && i + 1 < args.Length) adbPort = int.Parse(args[++i]);
                else if (name == "--allow-origin" && i + 1 < args.Length) Origins.Add(args[++i].Trim());
                else if (name == "--origins-file" && i + 1 < args.Length) originsFile = args[++i];
            }

            if (File.Exists(originsFile))
            {
                foreach (string line in File.ReadAllLines(originsFile))
                {
                    string origin = line.Trim();
                    if (origin.Length > 0 && !origin.StartsWith("#")) Origins.Add(origin);
                }
            }
        }

        private static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    FileInfo info = new FileInfo(logPath);
                    if (info.Exists && info.Length > 256 * 1024) File.Delete(logPath);
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
                }
            }
            catch (Exception)
            {
                // Logging must never stop the bridge.
            }
        }

        private static async Task Serve()
        {
            TcpListener listener = new TcpListener(IPAddress.Loopback, listenPort);
            listener.Start();

            Log("Bridge running on ws://127.0.0.1:" + listenPort + ", relaying to the ADB server at " + adbHost + ":" + adbPort);
            Log("Allowed web origins: " + string.Join(", ", new List<string>(Origins).ToArray()));

            Task ignored = Task.Run(delegate { EnsureAdbServer(); });

            while (true)
            {
                TcpClient client = await listener.AcceptTcpClientAsync();
                Task handler = Handle(client);
            }
        }

        // ---- one browser connection ------------------------------------------------

        private static async Task Handle(TcpClient client)
        {
            TcpClient upstream = null;

            try
            {
                client.NoDelay = true;
                NetworkStream stream = client.GetStream();

                string header = await ReadHeader(stream);
                if (header == null) return;

                Dictionary<string, string> headers = ParseHeaders(header);
                string upgrade;
                string key;
                headers.TryGetValue("upgrade", out upgrade);
                headers.TryGetValue("sec-websocket-key", out key);

                if (upgrade == null || !upgrade.Equals("websocket", StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(key))
                {
                    await Reply(stream, "426 Upgrade Required", "This is the SQLite Viewer ADB bridge.\n");
                    return;
                }

                string origin;
                headers.TryGetValue("origin", out origin);
                origin = origin ?? "";

                if (!Origins.Contains(origin))
                {
                    Log("Blocked connection from origin '" + origin + "'. Allow it with --allow-origin " + origin);
                    await Reply(stream, "403 Forbidden", "Origin not allowed.\n");
                    return;
                }

                upstream = await ConnectToAdb();

                string accept;
                using (SHA1 sha = SHA1.Create())
                {
                    accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + WebSocketGuid)));
                }

                byte[] response = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
                await stream.WriteAsync(response, 0, response.Length);

                if (upstream == null)
                {
                    // Tell the page the bridge is running but ADB is missing (close code 4001).
                    Log("Cannot reach the ADB server at " + adbHost + ":" + adbPort);
                    byte[] reason = Encoding.ASCII.GetBytes("adb-not-found");
                    byte[] closePayload = new byte[reason.Length + 2];
                    closePayload[0] = 0x0F;
                    closePayload[1] = 0xA1;
                    Array.Copy(reason, 0, closePayload, 2, reason.Length);
                    await SendFrame(stream, 0x8, closePayload, closePayload.Length, new SemaphoreSlim(1, 1));
                    return;
                }

                NetworkStream upstreamStream = upstream.GetStream();
                SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);

                Task toTcp = WebSocketToTcp(stream, upstreamStream, writeLock);
                Task toWebSocket = TcpToWebSocket(upstreamStream, stream, writeLock);
                await Task.WhenAny(toTcp, toWebSocket);
            }
            catch (Exception)
            {
                // The browser went away; nothing to report.
            }
            finally
            {
                try { if (upstream != null) upstream.Close(); } catch (Exception) { }
                try { client.Close(); } catch (Exception) { }
            }
        }

        private static async Task<string> ReadHeader(NetworkStream stream)
        {
            byte[] buffer = new byte[MaxHeader];
            int length = 0;
            Task timeout = Task.Delay(10000);

            while (length < buffer.Length)
            {
                Task<int> read = stream.ReadAsync(buffer, length, buffer.Length - length);
                Task finished = await Task.WhenAny(read, timeout);
                if (finished != read) return null;

                int count = read.Result;
                if (count <= 0) return null;
                length += count;

                string text = Encoding.GetEncoding("ISO-8859-1").GetString(buffer, 0, length);
                int end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (end >= 0) return text.Substring(0, end);
            }

            return null;
        }

        private static Dictionary<string, string> ParseHeaders(string header)
        {
            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string[] lines = header.Split(new string[] { "\r\n" }, StringSplitOptions.None);

            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon > 0) headers[lines[i].Substring(0, colon).Trim().ToLowerInvariant()] = lines[i].Substring(colon + 1).Trim();
            }

            return headers;
        }

        private static async Task Reply(NetworkStream stream, string status, string body)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body);
            byte[] head = Encoding.ASCII.GetBytes(
                "HTTP/1.1 " + status + "\r\nContent-Type: text/plain\r\nContent-Length: " + payload.Length +
                "\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(head, 0, head.Length);
            await stream.WriteAsync(payload, 0, payload.Length);
        }

        // ---- relaying -------------------------------------------------------------

        private static async Task<bool> ReadExact(Stream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int read = await stream.ReadAsync(buffer, offset, count - offset);
                if (read <= 0) return false;
                offset += read;
            }
            return true;
        }

        private static async Task WebSocketToTcp(NetworkStream client, NetworkStream upstream, SemaphoreSlim writeLock)
        {
            byte[] head = new byte[2];
            byte[] extended = new byte[8];
            byte[] mask = new byte[4];

            while (true)
            {
                if (!await ReadExact(client, head, 2)) return;

                int opcode = head[0] & 0x0F;
                bool masked = (head[1] & 0x80) != 0;
                long length = head[1] & 0x7F;

                if (length == 126)
                {
                    if (!await ReadExact(client, extended, 2)) return;
                    length = (extended[0] << 8) | extended[1];
                }
                else if (length == 127)
                {
                    if (!await ReadExact(client, extended, 8)) return;
                    length = 0;
                    for (int i = 0; i < 8; i++) length = (length << 8) | extended[i];
                }

                if (!masked || length > MaxFrame) return;
                if (!await ReadExact(client, mask, 4)) return;

                byte[] payload = new byte[length];
                if (length > 0 && !await ReadExact(client, payload, (int)length)) return;
                for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i & 3];

                if (opcode == 0x0 || opcode == 0x1 || opcode == 0x2)
                {
                    await upstream.WriteAsync(payload, 0, payload.Length);
                }
                else if (opcode == 0x8)
                {
                    return;
                }
                else if (opcode == 0x9)
                {
                    await SendFrame(client, 0xA, payload, payload.Length, writeLock);
                }
            }
        }

        private static async Task TcpToWebSocket(NetworkStream upstream, NetworkStream client, SemaphoreSlim writeLock)
        {
            byte[] buffer = new byte[64 * 1024];

            while (true)
            {
                int read = await upstream.ReadAsync(buffer, 0, buffer.Length);
                if (read <= 0) break;
                await SendFrame(client, 0x2, buffer, read, writeLock);
            }

            await SendFrame(client, 0x8, new byte[0], 0, writeLock);
        }

        private static async Task SendFrame(NetworkStream stream, int opcode, byte[] payload, int length, SemaphoreSlim writeLock)
        {
            byte[] header;

            if (length < 126)
            {
                header = new byte[] { (byte)(0x80 | opcode), (byte)length };
            }
            else if (length < 65536)
            {
                header = new byte[] { (byte)(0x80 | opcode), 126, (byte)(length >> 8), (byte)(length & 0xFF) };
            }
            else
            {
                header = new byte[10];
                header[0] = (byte)(0x80 | opcode);
                header[1] = 127;
                long size = length;
                for (int i = 9; i >= 2; i--)
                {
                    header[i] = (byte)(size & 0xFF);
                    size >>= 8;
                }
            }

            await writeLock.WaitAsync();
            try
            {
                await stream.WriteAsync(header, 0, header.Length);
                if (length > 0) await stream.WriteAsync(payload, 0, length);
                await stream.FlushAsync();
            }
            finally
            {
                writeLock.Release();
            }
        }

        // ---- the ADB server --------------------------------------------------------

        private static async Task<TcpClient> ConnectToAdb()
        {
            // Windows needs about two seconds to report a refused local port, so ask with a short timeout.
            if (!AdbReachable(400))
            {
                await Task.Run(delegate { EnsureAdbServer(); });
                if (!AdbReachable(1000)) return null;
            }

            TcpClient candidate = new TcpClient();

            try
            {
                await candidate.ConnectAsync(adbHost, adbPort);
                candidate.NoDelay = true;
                return candidate;
            }
            catch (Exception)
            {
                candidate.Close();
                return null;
            }
        }

        private static bool AdbReachable()
        {
            return AdbReachable(1000);
        }

        private static bool AdbReachable(int milliseconds)
        {
            try
            {
                using (TcpClient probe = new TcpClient())
                {
                    IAsyncResult pending = probe.BeginConnect(adbHost, adbPort, null, null);
                    if (!pending.AsyncWaitHandle.WaitOne(milliseconds)) return false;
                    probe.EndConnect(pending);
                    return true;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void EnsureAdbServer()
        {
            if (AdbReachable()) return;

            string adb = FindAdb();
            if (adb == null)
            {
                Log("No ADB server found on port " + adbPort + " and adb.exe was not found. Start Android Studio or install the Android Platform Tools.");
                return;
            }

            try
            {
                Log("Starting the ADB server with " + adb);
                ProcessStartInfo start = new ProcessStartInfo(adb, "-P " + adbPort + " start-server");
                start.CreateNoWindow = true;
                start.UseShellExecute = false;
                start.WindowStyle = ProcessWindowStyle.Hidden;

                using (Process process = Process.Start(start))
                {
                    if (process != null) process.WaitForExit(15000);
                }
            }
            catch (Exception error)
            {
                Log("Could not start adb: " + error.Message);
            }
        }

        private static string FindAdb()
        {
            List<string> candidates = new List<string>();

            foreach (string variable in new string[] { "ANDROID_HOME", "ANDROID_SDK_ROOT" })
            {
                string root = Environment.GetEnvironmentVariable(variable);
                if (!string.IsNullOrEmpty(root)) candidates.Add(Path.Combine(root, "platform-tools", "adb.exe"));
            }

            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (!string.IsNullOrEmpty(local))
            {
                candidates.Add(Path.Combine(local, "Android", "Sdk", "platform-tools", "adb.exe"));
                candidates.Add(Path.Combine(local, "Microsoft", "WinGet", "Links", "adb.exe"));
            }

            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string folder in path.Split(';'))
            {
                if (folder.Trim().Length > 0) candidates.Add(Path.Combine(folder.Trim(), "adb.exe"));
            }

            foreach (string candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate)) return candidate;
                }
                catch (Exception)
                {
                    // ignore invalid PATH entries
                }
            }

            return null;
        }
    }

}
