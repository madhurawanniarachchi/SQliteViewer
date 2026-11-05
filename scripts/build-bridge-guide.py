"""
Builds sqliteviewer_fixed/guides/adb-bridge-setup/index.html

Run from the repository root:   python scripts/build-bridge-guide.py
"""

import html
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "sqliteviewer_fixed")
BASE = "https://sqliteviewer.codemasterlk.com/"
SLUG = "guides/adb-bridge-setup"
URL = BASE + SLUG + "/"

TITLE = "ADB Bridge Setup: Use Android Studio and SQLite Viewer Together"
DESC = ("Step-by-step help to download, place and auto-start the small ADB bridge on Windows, macOS or Linux so SQLite Viewer "
        "can read your Android app database while Android Studio is running. No configuration needed.")
H1 = "Set up the ADB bridge (works alongside Android Studio)"


def code(text):
    return '<pre class="guide-code">%s</pre>' % html.escape(text)


WIN_FOLDER = r"%LOCALAPPDATA%\SQLiteViewerBridgePython"
PS_FOLDER = r"$env:LOCALAPPDATA\SQLiteViewerBridgePython"

ADB_ZIP = "https://dl.google.com/android/repository/platform-tools-latest-%s.zip"
ADB_WINDOWS_ZIP = ('Invoke-WebRequest %s -OutFile "$env:TEMP\\pt.zip"; '
                   'Expand-Archive "$env:TEMP\\pt.zip" "$env:LOCALAPPDATA\\Android\\Sdk" -Force; Remove-Item "$env:TEMP\\pt.zip"') % (ADB_ZIP % "windows")

STEPS_WINDOWS = [
    ("Download the installer", 'In SQLite Viewer, open <strong>Live Android</strong>, choose <strong>ADB server</strong> and click <strong>Download the installer (Windows)</strong>.'),
    ("Keep the file", "Chrome may say the file cannot be verified. Choose <strong>Keep</strong> (or <strong>Download unverified file</strong>). The file is plain text, so you can open it in Notepad to read exactly what it does."),
    ("Run it once", "Double-click <code>Install-ADB-Bridge.cmd</code>. If Windows shows <strong>Windows protected your PC</strong>, click <strong>More info</strong>, then <strong>Run anyway</strong>."),
    ("Come back to the page", "The installer builds the bridge on your PC, makes it start by itself every time you sign in, and starts it. SQLite Viewer notices it within a few seconds. Click <strong>Connect through bridge</strong>."),
]

STEPS_PYTHON = [
    ("Install Python 3", 'Download it from <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">python.org</a>. On Windows, tick <strong>Add Python to PATH</strong> in the installer. Most Linux systems already have <code>python3</code>. <strong>macOS does not include it by default</strong>: the first time you type <code>python3</code>, macOS offers to install Apple&#39;s Command Line Tools (accept it), or you can use the installer from python.org.'),
    ("Download the file", 'Download <a href="../../tools/adb-bridge.py.txt" download="adb-bridge.py">adb-bridge.py</a>. Your browser saves it in the Downloads folder. If it ends in <code>.txt</code>, rename it to <code>adb-bridge.py</code>.'),
    ("Copy it to its permanent place", "Open a terminal (any folder works, the commands use full paths) and run the command for your system. It creates the folder and copies the file into it. If your browser saved the file somewhere other than Downloads, change that part of the command."),
    ("Make it start by itself", "Run the command for your system. It sets up the start-at-sign-in entry for the file where you copied it, and starts the bridge now."),
    ("Connect", 'Go back to SQLite Viewer. It finds the bridge by itself. Click <strong>Connect through bridge</strong>.'),
]


def build():
    body = []
    body.append("<h2>Do I need the bridge?</h2>")
    body.append("<p>Often not. SQLite Viewer can talk to your phone directly over USB (<strong>USB direct</strong> mode in Chrome or Edge), with nothing to install. "
                "The bridge is for one situation: <strong>Android Studio (or another ADB tool) is already using the phone</strong>. "
                "Only one program can own the USB connection, so the bridge lets SQLite Viewer share Android Studio&#39;s ADB server instead. Both then work at the same time.</p>")
    body.append('<table class="guide-table"><thead><tr><th></th><th>USB direct</th><th>ADB server (bridge)</th></tr></thead><tbody>'
                "<tr><td>Install anything?</td><td>No</td><td>Yes, once (one click on Windows)</td></tr>"
                "<tr><td>Works with Android Studio open?</td><td>No, it must be closed</td><td>Yes</td></tr>"
                "<tr><td>Browser</td><td>Chrome or Edge on desktop</td><td>Any modern browser</td></tr>"
                "<tr><td>Needs ADB on the PC?</td><td>No</td><td>Yes (Android Studio or Platform Tools)</td></tr>"
                "</tbody></table>")

    body.append("<h2>Windows: one-click installer</h2><ol>")
    for name, text in STEPS_WINDOWS:
        body.append("<li><strong>%s.</strong> %s</li>" % (name, text))
    body.append("</ol>")
    body.append("<p>The bridge is installed in <code>%LOCALAPPDATA%\\SQLiteViewerBridge</code> and a shortcut in your Startup folder starts it at sign-in. "
                "To remove it, run <code>uninstall.cmd</code> from that folder.</p>")

    body.append("<h2>Any system: set it up with Python</h2><ol>")
    for name, text in STEPS_PYTHON:
        body.append("<li><strong>%s.</strong> %s</li>" % (name, text))
    body.append("</ol>")

    body.append("<h3>Step 3: copy the file (run once)</h3>")
    body.append("<p>Windows (PowerShell, press the Windows key, type <code>powershell</code>, press Enter):</p>" + code(
        'New-Item -ItemType Directory -Force "%s" | Out-Null; Copy-Item "$env:USERPROFILE\\Downloads\\adb-bridge.py" "%s\\adb-bridge.py"' % (PS_FOLDER, PS_FOLDER)))
    body.append("<p>Windows (Command Prompt, press the Windows key, type <code>cmd</code>, press Enter):</p>" + code(
        'mkdir "%s" & copy "%%USERPROFILE%%\\Downloads\\adb-bridge.py" "%s\\adb-bridge.py"' % (WIN_FOLDER, WIN_FOLDER)))
    body.append("<p>macOS (Terminal):</p>" + code(
        'mkdir -p "$HOME/Library/Application Support/SQLiteViewerBridge" && cp "$HOME/Downloads/adb-bridge.py" "$HOME/Library/Application Support/SQLiteViewerBridge/adb-bridge.py"'))
    body.append("<p>Linux:</p>" + code(
        'mkdir -p "$HOME/.local/share/sqliteviewer-bridge" && cp "$HOME/Downloads/adb-bridge.py" "$HOME/.local/share/sqliteviewer-bridge/adb-bridge.py"'))

    body.append("<h3>Step 4: start it by itself at sign-in (run once)</h3>")
    body.append("<p>Windows (PowerShell):</p>" + code('python "%s\\adb-bridge.py" --add-to-startup' % PS_FOLDER))
    body.append("<p>Windows (Command Prompt):</p>" + code('python "%s\\adb-bridge.py" --add-to-startup' % WIN_FOLDER))
    body.append("<p>macOS:</p>" + code('python3 "$HOME/Library/Application Support/SQLiteViewerBridge/adb-bridge.py" --add-to-startup'))
    body.append("<p>Linux:</p>" + code('python3 "$HOME/.local/share/sqliteviewer-bridge/adb-bridge.py" --add-to-startup'))
    body.append("<p>On Windows this creates a hidden shortcut in your Startup folder, on macOS a Launch Agent, and on Linux a systemd user service "
                "(or a desktop autostart entry). None of them needs administrator rights. Keep the file where it is; if you move it, run the command again.</p>")

    body.append("<h3>In a hurry? One command does steps 3 and 4</h3>")
    body.append("<p>Open a terminal in the folder where you downloaded the file and run:</p>" + code("python adb-bridge.py --install      # Windows\npython3 adb-bridge.py --install     # macOS and Linux"))

    body.append("<h3>Prefer to add it to Startup by hand?</h3>")
    body.append("<p><strong>Windows:</strong> press <strong>Win + R</strong>, type <code>shell:startup</code> and press Enter. In the folder that opens, right-click, choose <strong>New &rarr; Shortcut</strong> "
                "and set the location to:</p>" + code('pythonw "%s\\adb-bridge.py"' % WIN_FOLDER)
                + "<p>Name it <em>SQLite Viewer ADB Bridge</em>. Using <code>pythonw</code> instead of <code>python</code> keeps the black window away. "
                "Sign out and in, or double-click the shortcut to start it now.</p>")
    body.append("<p><strong>macOS:</strong> the command above creates <code>~/Library/LaunchAgents/com.sqliteviewer.adbbridge.plist</code>. "
                "<strong>Linux:</strong> it creates <code>~/.config/systemd/user/sqliteviewer-bridge.service</code> (or <code>~/.config/autostart/sqliteviewer-bridge.desktop</code>). "
                "Writing those files by hand is possible, but the command is safer.</p>")

    body.append("<h3>Check, stop and remove it</h3>")
    body.append(code("python adb-bridge.py --status                  # is it running?\n"
                     "python adb-bridge.py --remove-from-startup      # stop starting at sign-in (keeps the file)\n"
                     "python adb-bridge.py --uninstall                # stop it and delete everything\n"
                     "# add the full path to the file if you are not in its folder, as in the commands above"))

    body.append("<h2>Do I have ADB? Install it if not</h2>")
    body.append("<p>The bridge relays to <strong>ADB</strong> (Android Platform Tools). <strong>Android Studio already includes it</strong>, so if you use Android Studio you can skip this section. "
                "To check, open a terminal and run <code>adb version</code>. If the system does not know the command, install ADB with one of the commands below. "
                "SQLite Viewer also tells you when the bridge is running but cannot find ADB. "
                "The bridge looks for ADB on your PATH and in the usual Android Studio, winget, Homebrew and manual-download folders, "
                "so you do not need to change PATH, and it starts the ADB server for you.</p>")
    body.append("<h3>Windows</h3>")
    body.append("<p>Easiest (Windows 10 and 11, PowerShell or Command Prompt):</p>" + code("winget install --id Google.PlatformTools -e"))
    body.append("<p>No winget? Download it directly (PowerShell):</p>" + code(ADB_WINDOWS_ZIP))
    body.append("<p>The same in Command Prompt:</p>" + code('powershell -NoProfile -Command "%s"' % ADB_WINDOWS_ZIP.replace('"', '\\"')))
    body.append("<p>Check that it worked (PowerShell):</p>" + code('& "$env:LOCALAPPDATA\\Android\\Sdk\\platform-tools\\adb.exe" version'))
    body.append("<h3>macOS</h3>")
    body.append("<p>With <a href=\"https://brew.sh/\" target=\"_blank\" rel=\"noopener\">Homebrew</a>:</p>" + code("brew install --cask android-platform-tools"))
    body.append("<p>Without Homebrew:</p>" + code(
        'mkdir -p "$HOME/Library/Android/sdk" && curl -L -o /tmp/pt.zip %s && unzip -o /tmp/pt.zip -d "$HOME/Library/Android/sdk" && rm /tmp/pt.zip' % (ADB_ZIP % "darwin")))
    body.append("<h3>Linux</h3>")
    body.append("<p>Debian, Ubuntu, Mint:</p>" + code("sudo apt install adb"))
    body.append("<p>Fedora:</p>" + code("sudo dnf install android-tools"))
    body.append("<p>Arch, Manjaro:</p>" + code("sudo pacman -S android-tools"))
    body.append("<p>Any other distribution:</p>" + code(
        'mkdir -p "$HOME/Android/Sdk" && curl -L -o /tmp/pt.zip %s && unzip -o /tmp/pt.zip -d "$HOME/Android/Sdk" && rm /tmp/pt.zip' % (ADB_ZIP % "linux")))
    body.append("<h3>Then prepare the phone</h3>")
    body.append("<ol><li>On the phone open <strong>Settings &rarr; About phone</strong> and tap <strong>Build number</strong> seven times.</li>"
                "<li>Open <strong>Settings &rarr; Developer options</strong> and turn on <strong>USB debugging</strong>.</li>"
                "<li>Plug the phone in and tap <strong>Allow</strong> on the prompt. Running <code>adb devices</code> should list it as <code>device</code>.</li></ol>")

    body.append("<h2>Do I need to configure anything?</h2>")
    body.append("<p><strong>No.</strong> The bridge only accepts connections from the SQLite Viewer website, listens on your own computer only (<code>127.0.0.1</code>), "
                "and only relays to the ADB server on the same computer. Nothing is stored or sent anywhere else.</p>")
    body.append("<p>You only need a setting in two cases:</p><ul>"
                "<li><strong>You use SQLite Viewer from a different address</strong> (your own copy, or <code>localhost</code> while developing). Allow that address in the same commands:</li></ul>")
    body.append(code('python "%s\\adb-bridge.py" --add-to-startup --allow-origin https://your-address.example' % WIN_FOLDER))
    body.append("<ul><li><strong>Port 5038 is already used.</strong> Use another port, then enter the same port under <strong>Advanced</strong> in the Android panel:</li></ul>")
    body.append(code('python "%s\\adb-bridge.py" --add-to-startup --port 5040' % WIN_FOLDER))
    body.append("<p>Allowed addresses are remembered in a file called <code>origins.txt</code> (one address per line) next to the bridge: "
                "Windows <code>%LOCALAPPDATA%\\SQLiteViewerBridge</code> (installer) or <code>%LOCALAPPDATA%\\SQLiteViewerBridgePython</code> (Python), "
                "macOS <code>~/Library/Application Support/SQLiteViewerBridge</code>, Linux <code>~/.local/share/sqliteviewer-bridge</code>.</p>")

    body.append("<h2>Troubleshooting</h2><ul>"
                "<li><strong>&quot;The bridge is not running on this computer&quot;:</strong> run the installer or the commands above, or sign out and in. Then reopen the Android panel.</li>"
                "<li><strong>I do not have Python:</strong> on Windows you do not need it, use the one-click installer above. Otherwise install Python 3 from python.org (Windows: tick <strong>Add Python to PATH</strong>), or on macOS accept the offer to install the Command Line Tools. Then run the commands again.</li>"
                "<li><strong><code>python</code> is not recognised, or opens the Microsoft Store (Windows):</strong> Python is not installed yet, or its PATH option was missed. Install it from python.org, or replace <code>python</code> with <code>py</code> in the commands. You can also switch off the Store shortcut in <em>Settings &rarr; Apps &rarr; Advanced app settings &rarr; App execution aliases</em>.</li>"
                "<li><strong>The copy command says the file cannot be found:</strong> your browser saved <code>adb-bridge.py</code> somewhere other than Downloads. Change that part of the command, or rename a <code>.txt</code> file.</li>"
                "<li><strong>&quot;Something is already listening on port 5038&quot;:</strong> another bridge is running. Remove the old one (<code>--uninstall</code> or <code>uninstall.cmd</code>) or choose another port with <code>--port</code>.</li>"
                "<li><strong>The bridge runs but no phone appears:</strong> the ADB server must see the phone. Run <code>adb devices</code>, enable USB debugging, and accept the &quot;Allow USB debugging&quot; prompt on the phone.</li>"
                '<li><strong>&quot;The bridge is running, but ADB is not installed&quot;:</strong> install ADB with the commands in the <em>Do I have ADB?</em> section above (or install Android Studio). The page notices by itself a few seconds later.</li>'
                "<li><strong>Chrome asks to allow access to devices on your network:</strong> allow it. This is how the page reaches the bridge on your own computer.</li>"
                "<li><strong>Antivirus or Windows blocks the installer:</strong> the installer only builds a small program from source you can read, and writes to your own user folders. Allow it, or use the Python route instead.</li>"
                "</ul>")
    return "".join(body)


def page():
    main = build()

    ld = [
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "SQLite Viewer", "item": BASE},
            {"@type": "ListItem", "position": 2, "name": H1, "item": URL}]},
        {"@context": "https://schema.org", "@type": "HowTo", "name": "Set up the ADB bridge for SQLite Viewer", "description": DESC,
         "totalTime": "PT5M",
         "step": [{"@type": "HowToStep", "name": n, "text": html.unescape(re.sub("<[^>]+>", "", t))} for n, t in STEPS_PYTHON]},
        {"@context": "https://schema.org", "@type": "Article", "headline": H1, "description": DESC, "url": URL, "mainEntityOfPage": URL,
         "dateModified": "2026-10-08", "image": BASE + "img/og-sqlite-viewer.png",
         "author": {"@type": "Organization", "name": "CodeMasterLk", "url": BASE},
         "publisher": {"@type": "Organization", "name": "CodeMasterLk", "url": BASE}},
    ]

    theme = ('<script>(function(){var p="system";try{p=localStorage.getItem("sqlite-viewer-theme")||"system"}catch(e){}'
             'if(["system","light","dark"].indexOf(p)===-1)p="system";'
             'var r=p==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;'
             'document.documentElement.dataset.theme=r;document.documentElement.style.colorScheme=r;}());</script>')

    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(TITLE)}</title><meta name="description" content="{html.escape(DESC, quote=True)}"><meta name="robots" content="index, follow"><link rel="canonical" href="{URL}">
<meta property="og:title" content="{html.escape(TITLE)}"><meta property="og:description" content="Download, place and auto-start the small ADB bridge so SQLite Viewer and Android Studio can use your phone at the same time."><meta property="og:type" content="article"><meta property="og:url" content="{URL}"><meta property="og:image" content="{BASE}img/og-sqlite-viewer.png"><link rel="icon" href="../../img/icon.png"><link rel="stylesheet" href="../../css/content.css?v=26.10.49"><script type="application/ld+json">{json.dumps(ld, ensure_ascii=False, separators=(",", ":"))}</script>
{theme}</head>
<body class="guide-page"><header class="guide-site-header"><nav class="guide-nav" aria-label="Main navigation"><a class="guide-brand" href="../../">SQLite Viewer</a><div class="guide-nav-links"><a href="../../view-android-sqlite-database/">Android databases</a><a href="../android-live-edit/">Live edit</a><a class="guide-cta" href="../../">Open the viewer</a></div></nav></header>
<main class="guide-main"><header class="guide-hero"><p class="guide-kicker">Android live debugging</p><h1>{html.escape(H1)}</h1><p class="guide-summary">One small helper lets SQLite Viewer and Android Studio use your phone at the same time. Download it, put it in place, make it start by itself, and you are done.</p><a class="guide-cta" href="../../">Open the viewer</a></header>
<article class="guide-article">{main}</article>
<nav class="guide-related" aria-label="Related guides"><a href="../../view-android-sqlite-database/">View an Android database</a><a href="../android-live-edit/">Live edit an Android app database</a><a href="../sqlite-queries/">SQLite query examples</a></nav></main>
<footer class="guide-footer">&copy; 2026 CodeMasterLk · <a href="../../privacy/">Privacy</a> · <a href="../../">SQLite Viewer</a></footer></body></html>
'''


def main():
    out_dir = os.path.join(SITE, "guides", "adb-bridge-setup")
    os.makedirs(out_dir, exist_ok=True)
    text = page()
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    print("wrote guide:", len(text), "bytes")


if __name__ == "__main__":
    main()
