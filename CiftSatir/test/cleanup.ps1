# DualSub test kalıntılarını temizler.
#
# Testler yarıda kesildiğinde (zaman aşımı, Ctrl+C, çöken test) Playwright'ın
# açtığı Edge pencereleri kapanmadan kalabiliyor. Edge bunları gizli tuttuğu için
# görev çubuğunda görünmüyorlar ama Alt+Tab listesinde duruyorlar. Bu betik
# yalnızca test süreçlerine ve test geçici klasörlerine dokunur; eklenti
# dosyalarına, ayarlarına ve kullanıcının kendi tarayıcısına dokunmaz.
#
#   powershell -ExecutionPolicy Bypass -File test\cleanup.ps1
#
# Ne yapar:
#   1. Komut satırında Playwright/test izi taşıyan veya başlığı DualSub test
#      sayfası olan Edge pencerelerini kapatır.
#   2. Port 5331 (test sunucusu) dinleyen yetim süreçleri kapatır.
#   3. %TEMP% altındaki dualsub-* ve playwright-artifacts-* klasörlerini siler.
#   4. Alt+Tab'da kalan hayalet küçük resimler için Explorer'ı yeniler
#      (-RefreshExplorer ile).

param(
  [switch]$RefreshExplorer,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$killed = 0
$removedDirs = 0

function Write-Step($text) { Write-Host "== $text" -ForegroundColor Cyan }

# ---- 1. test tarayıcıları -------------------------------------------------

Write-Step 'Test tarayıcı süreçleri'

# Yalnızca test imzası taşıyan Edge süreçleri. Kullanıcının normal tarayıcısı
# (varsayılan profil, imzasız) asla eşleşmez.
$testSignatures = 'playwright|--remote-debugging-pipe|dualsub-dbg|dualsub-life|dualsub-live|dualsub-players|dualsub-yt|dualsub-nf|--no-startup-window'

$browsers = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $testSignatures }

foreach ($proc in $browsers) {
  $root = $proc
  # Yalnızca tarayıcı (parent) sürecini hedefle; çocukları /T ile birlikte gider.
  if ($proc.CommandLine -match '--type=') {
    continue
  }
  Write-Host ("  kapat: pid {0}" -f $proc.ProcessId)
  if (-not $DryRun) {
    & taskkill /PID $proc.ProcessId /T /F 2>&1 | Out-Null
  }
  $killed += 1
}

# Test sayfası başlığı taşıyan pencereler (imza değişmiş olabilir).
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DualSubWindowScan {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static int CloseTitled(string a, string b) {
    int n = 0;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(400);
      GetWindowText(h, sb, 400);
      string t = sb.ToString();
      if (t.IndexOf(a, StringComparison.OrdinalIgnoreCase) >= 0 ||
          (b != null && t.IndexOf(b, StringComparison.OrdinalIgnoreCase) >= 0)) {
        PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
        n++;
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@ -ErrorAction SilentlyContinue

if (-not $DryRun) {
  $closed = [DualSubWindowScan]::CloseTitled('DualSub player test', 'DualSub lifecycle')
  if ($closed -gt 0) {
    Write-Host ("  başlıkla kapatıldı: {0} pencere" -f $closed)
    $killed += $closed
  }
}

if ($killed -eq 0) {
  Write-Host '  temiz (kapatılacak süreç yok)'
}

# ---- 2. yetim test sunucuları ---------------------------------------------

Write-Step 'Port 5331 (test sunucusu)'

$listeners = Get-NetTCPConnection -LocalPort 5331 -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  foreach ($conn in $listeners) {
    $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($owner) {
      Write-Host ("  kapat: {0} (pid {1})" -f $owner.ProcessName, $owner.Id)
      if (-not $DryRun) { & taskkill /PID $owner.Id /T /F 2>&1 | Out-Null }
      $killed += 1
    }
  }
} else {
  Write-Host '  temiz (dinleyen yok)'
}

# ---- 3. geçici profiller ---------------------------------------------------

Write-Step 'Geçici test klasörleri'

$patterns = 'dualsub-(dbg|life|live|nf|players|yt)-', 'playwright-artifacts-'
$tempDirs = Get-ChildItem $env:TEMP -Directory -ErrorAction SilentlyContinue | Where-Object {
  $name = $_.Name
  $patterns | Where-Object { $name -like ($_ + '*') } | Select-Object -First 1
}

foreach ($dir in $tempDirs) {
  if ($DryRun) {
    Write-Host ("  silinecek: {0}" -f $dir.Name)
    continue
  }
  try {
    Remove-Item $dir.FullName -Recurse -Force -ErrorAction Stop
    $removedDirs += 1
  } catch {
    Write-Host ("  atlandı (kilitli): {0}" -f $dir.Name) -ForegroundColor Yellow
  }
}

if ($removedDirs -eq 0 -and -not $tempDirs) {
  Write-Host '  temiz (klasör yok)'
} elseif ($removedDirs -gt 0) {
  Write-Host ("  silindi: {0} klasör" -f $removedDirs)
}

# ---- 4. Alt+Tab hayaletleri ----------------------------------------------

if ($RefreshExplorer) {
  Write-Step 'Explorer yenileniyor (Alt+Tab küçük resim önbelleği)'
  if (-not $DryRun) {
    & taskkill /IM explorer.exe /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 800
    Start-Process explorer.exe
    Write-Host '  görev çubuğu yeniden başlatıldı'
  }
}

# ---- özet -----------------------------------------------------------------

Write-Host ''
Write-Host ("Özet: {0} süreç/pencere kapatıldı, {1} klasör silindi." -f $killed, $removedDirs)
Write-Host 'DualSub klasöründeki hiçbir dosyaya dokunulmadı.'
