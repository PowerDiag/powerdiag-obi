<#
.SYNOPSIS
  Batch flasher for the FTDI Arduino Nano clones (optiboot bootloader) used by the OBI project.

  These clones' auto-reset does NOT work with avrdude / PlatformIO upload, so this script talks
  the STK500v1 protocol directly and pulses DTR+RTS itself to enter the bootloader.

.EXAMPLE
  # Flash one board (auto-detects the FTDI COM port)
  .\Flash-Nano.ps1

.EXAMPLE
  # Production line: plug a board, it flashes, unplug it, plug the next, repeat.
  .\Flash-Nano.ps1 -Loop

.EXAMPLE
  # Force a specific port and hex
  .\Flash-Nano.ps1 -Port COM12 -Hex ..\.pio\build\nano\firmware.hex

.NOTES
  Bootloader baud is auto-detected (tries 115200 then 57600). After flashing, the OBI
  firmware runs its own serial protocol at 9600 baud; the script verifies with a version query.
#>
[CmdletBinding()]
param(
  [string]   $Port,                                            # COM port; auto-detect FTDI if omitted
  [string]   $Hex = "$PSScriptRoot\..\.pio\build\nano\firmware.hex",
  [int[]]    $BootBaud = @(115200, 57600),                     # bootloader sync bauds to try, in order
  [int]      $AppBaud = 9600,                                  # OBI firmware serial baud (post-flash check)
  [switch]   $Loop,                                            # keep flashing boards as they are plugged in
  [switch]   $NoVerifyRun                                      # skip the post-flash version query
)

$ErrorActionPreference = 'Stop'
$PAGE = 128   # optiboot atmega328p flash page size (bytes)

# ------------------------------------------------------------------ helpers
function Get-FtdiPorts {
  # Return COM port names for every connected USB-serial adapter used on Nano clones:
  #   FTDI (VID_0403), CH340/CH341 (VID_1A86), CP210x (VID_10C4), genuine Arduino (VID_2341).
  # The Intel internal ports (VID_8087) are intentionally excluded.
  $vids = 'VID_0403|VID_1A86|VID_10C4|VID_2341'
  Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object { $_.DeviceID -match $vids -and $_.Name -match '\(COM(\d+)\)' } |
    ForEach-Object { if ($_.Name -match '\((COM\d+)\)') { $Matches[1] } } |
    Sort-Object { [int]($_ -replace '\D') }
}

function Resolve-Port {
  if ($Port) { return $Port }
  $ftdi = @(Get-FtdiPorts)
  if ($ftdi.Count -eq 1) { return $ftdi[0] }
  if ($ftdi.Count -eq 0) { throw "No FTDI serial port found. Plug in the Nano (or pass -Port COMx)." }
  throw "Multiple FTDI ports found: $($ftdi -join ', '). Pass -Port to pick one."
}

function Read-HexImage($path) {
  if (-not (Test-Path $path)) {
    throw "Firmware not found: $path`nBuild it first:  pio run -e nano"
  }
  $mem = @{}; $maxAddr = -1; $base = 0
  foreach ($line in Get-Content $path) {
    if ($line -notmatch '^:') { continue }
    $b = for ($i = 1; $i -lt $line.Length; $i += 2) { [Convert]::ToByte($line.Substring($i, 2), 16) }
    $len = [int]$b[0]
    $addr = ([int]$b[1] * 256) + [int]$b[2]     # NOTE: [byte] -shl 8 masks to 0 in PowerShell — use *256
    $type = $b[3]
    if ($type -eq 0) {
      for ($k = 0; $k -lt $len; $k++) { $a = $base + $addr + $k; $mem[$a] = $b[4 + $k]; if ($a -gt $maxAddr) { $maxAddr = $a } }
    } elseif ($type -eq 4) {
      $base = (([int]$b[4] * 256) + [int]$b[5]) * 65536
    } elseif ($type -eq 1) { break }
  }
  $size = $maxAddr + 1
  if ($size % $PAGE) { $size += ($PAGE - ($size % $PAGE)) }
  $img = New-Object byte[] $size
  for ($i = 0; $i -lt $size; $i++) { $img[$i] = 0xFF }
  foreach ($a in $mem.Keys) { $img[$a] = $mem[$a] }
  [pscustomobject]@{ Image = $img; DataBytes = $mem.Count; Pages = [int]($size / $PAGE) }
}

function Reset-Board($sp) {
  $sp.DtrEnable = $true;  $sp.RtsEnable = $true
  Start-Sleep -Milliseconds 60
  $sp.DtrEnable = $false; $sp.RtsEnable = $false
  Start-Sleep -Milliseconds 250
  $sp.DiscardInBuffer()
}

function Send($sp, $arr) { $sp.Write([byte[]]$arr, 0, $arr.Length) }

function Expect-Ok($sp, $what) {          # want 0x14 (INSYNC) ... 0x10 (OK)
  $deadline = 120; $got = @()
  while ($deadline-- -gt 0) {
    while ($sp.BytesToRead -gt 0) { $got += $sp.ReadByte() }
    if ($got.Count -ge 2 -and $got[0] -eq 0x14 -and $got[-1] -eq 0x10) { return }
    Start-Sleep -Milliseconds 5
  }
  throw "$what : bad resp [$(($got | ForEach-Object { $_.ToString('X2') }) -join ' ')]"
}

function Drain-Quiet($sp, $quietMs = 150) {
  # Read and discard until the line has been silent for $quietMs — clears any
  # trailing/cascading bootloader replies so the next command starts byte-aligned.
  $quiet = 0
  while ($quiet -lt $quietMs) {
    if ($sp.BytesToRead -gt 0) { $sp.ReadByte() | Out-Null; $quiet = 0 }
    else { Start-Sleep -Milliseconds 15; $quiet += 15 }
  }
}

function Try-Sync($sp) {
  Reset-Board $sp
  for ($i = 0; $i -lt 8; $i++) {
    Drain-Quiet $sp 60                       # start each attempt from a quiet line
    Send $sp @(0x30, 0x20)
    Start-Sleep -Milliseconds 80
    $got = @(); while ($sp.BytesToRead -gt 0) { $got += $sp.ReadByte() }
    if ($got -contains 0x14 -and $got -contains 0x10) {
      Drain-Quiet $sp 150                     # settle before the caller sends ENTER_PROGMODE
      return $true
    }
  }
  return $false
}

# ------------------------------------------------------------------ core: flash one board
function Flash-One($portName, $hexInfo) {
  $img = $hexInfo.Image; $pages = $hexInfo.Pages
  $sp = New-Object System.IO.Ports.SerialPort $portName, ($BootBaud[0]), 'None', 8, 'One'
  $sp.ReadTimeout = 700; $sp.WriteTimeout = 700

  # --- sync (auto-detect bootloader baud) ---
  $synced = $false; $usedBaud = 0
  foreach ($baud in $BootBaud) {
    if ($sp.IsOpen) { $sp.Close() }
    $sp.BaudRate = $baud; $sp.Open()
    if (Try-Sync $sp) { $synced = $true; $usedBaud = $baud; break }
  }
  if (-not $synced) { $sp.Close(); throw "Could not enter bootloader on $portName (tried $($BootBaud -join '/'))" }
  Start-Sleep -Milliseconds 50; $sp.DiscardInBuffer()
  Write-Host ("  synced @ {0} baud" -f $usedBaud) -ForegroundColor DarkGray

  try {
    # --- program ---
    Send $sp @(0x50, 0x20); Expect-Ok $sp "ENTER_PROGMODE"
    for ($pg = 0; $pg -lt $pages; $pg++) {
      $byteAddr = $pg * $PAGE; $wordAddr = [int]($byteAddr / 2)
      Send $sp @(0x55, ($wordAddr -band 0xFF), (($wordAddr -shr 8) -band 0xFF), 0x20); Expect-Ok $sp "LOAD_ADDR $pg"
      $rec = New-Object System.Collections.Generic.List[byte]
      $rec.Add(0x64); $rec.Add(0); $rec.Add($PAGE); $rec.Add(0x46)
      for ($j = 0; $j -lt $PAGE; $j++) { $rec.Add($img[$byteAddr + $j]) }
      $rec.Add(0x20)
      Send $sp $rec.ToArray(); Expect-Ok $sp "PROG_PAGE $pg"
    }
    # --- verify (read-back) ---
    for ($pg = 0; $pg -lt $pages; $pg++) {
      $byteAddr = $pg * $PAGE; $wordAddr = [int]($byteAddr / 2)
      Send $sp @(0x55, ($wordAddr -band 0xFF), (($wordAddr -shr 8) -band 0xFF), 0x20); Expect-Ok $sp "V_LOAD_ADDR $pg"
      Send $sp @(0x74, 0, $PAGE, 0x46, 0x20)
      $buf = New-Object System.Collections.Generic.List[byte]; $need = $PAGE + 2; $d = 200
      while ($buf.Count -lt $need -and $d-- -gt 0) { if ($sp.BytesToRead -gt 0) { $buf.Add($sp.ReadByte()) } else { Start-Sleep -Milliseconds 5 } }
      if ($buf.Count -lt $need -or $buf[0] -ne 0x14 -or $buf[-1] -ne 0x10) { throw "verify framing error on page $pg" }
      for ($j = 0; $j -lt $PAGE; $j++) { if ($buf[1 + $j] -ne $img[$byteAddr + $j]) { throw "verify mismatch at 0x$("{0:X}" -f ($byteAddr + $j))" } }
    }
    Send $sp @(0x51, 0x20); try { Expect-Ok $sp "LEAVE_PROGMODE" } catch {}
    Reset-Board $sp   # run the new firmware
  } finally {
    if ($sp.IsOpen) { $sp.Close() }
  }
}

# ------------------------------------------------------------------ post-flash sanity: query OBI version
function Test-Firmware($portName) {
  $sp = New-Object System.IO.Ports.SerialPort $portName, $AppBaud, 'None', 8, 'One'
  $sp.ReadTimeout = 1200
  try {
    $sp.Open()
    $sp.DtrEnable = $true; $sp.RtsEnable = $true; Start-Sleep -Milliseconds 60; $sp.DtrEnable = $false; $sp.RtsEnable = $false
    Start-Sleep -Milliseconds 2500                       # let the sketch finish booting
    for ($t = 0; $t -lt 3; $t++) {
      $sp.DiscardInBuffer()
      $sp.Write([byte[]](0x01, 0x00, 0x03, 0x01), 0, 4)  # INTERFACE_VERSION_CMD
      Start-Sleep -Milliseconds 500
      $got = @(); while ($sp.BytesToRead -gt 0) { $got += $sp.ReadByte() }
      if ($got.Count -ge 5) { return ('{0}.{1}.{2}' -f $got[2], $got[3], $got[4]) }
    }
    return $null
  } catch { return $null } finally { if ($sp.IsOpen) { $sp.Close() } }
}

# ------------------------------------------------------------------ orchestration
$hexInfo = Read-HexImage $Hex
Write-Host ("Firmware: {0}  ({1} bytes, {2} pages)" -f (Split-Path $Hex -Leaf), $hexInfo.DataBytes, $hexInfo.Pages) -ForegroundColor Cyan

function Flash-Reporting($portName) {
  Write-Host ("`n[{0}] flashing..." -f $portName) -ForegroundColor White
  $attempts = 3
  for ($try = 1; $try -le $attempts; $try++) {
    try { Flash-One $portName $hexInfo; break }
    catch {
      if ($try -lt $attempts) {
        Write-Host ("  attempt {0}/{1} failed ({2}); retrying..." -f $try, $attempts, $_.Exception.Message) -ForegroundColor DarkYellow
        Start-Sleep -Milliseconds 400
      } else {
        Write-Host ("[{0}] FAILED - {1}" -f $portName, $_.Exception.Message) -ForegroundColor Red
        return $false
      }
    }
  }
  try {
    if ($NoVerifyRun) {
      Write-Host ("[{0}] OK - flashed & verified" -f $portName) -ForegroundColor Green
    } else {
      $ver = Test-Firmware $portName
      if ($ver) { Write-Host ("[{0}] OK - firmware running, version {1}" -f $portName, $ver) -ForegroundColor Green }
      else      { Write-Host ("[{0}] OK - flashed & verified (no version reply; check manually)" -f $portName) -ForegroundColor Yellow }
    }
    return $true
  } catch {
    Write-Host ("[{0}] FAILED - {1}" -f $portName, $_.Exception.Message) -ForegroundColor Red
    return $false
  }
}

if (-not $Loop) {
  $ok = Flash-Reporting (Resolve-Port)
  exit ([int](-not $ok))
}

# ---- Loop mode: flash each board as it appears; wait for unplug before the next ----
$done = 0; $fail = 0
Write-Host "`nLOOP MODE - plug in a board to flash it, unplug when done. Ctrl+C to stop.`n" -ForegroundColor Cyan
while ($true) {
  # wait for exactly one FTDI port
  do { $ports = @(Get-FtdiPorts); Start-Sleep -Milliseconds 400 } while ($ports.Count -eq 0)
  if ($ports.Count -gt 1) {
    Write-Host ("Multiple FTDI ports present ({0}); plug ONE board at a time." -f ($ports -join ', ')) -ForegroundColor Yellow
    do { Start-Sleep -Milliseconds 500 } while (@(Get-FtdiPorts).Count -ne 0)
    continue
  }
  $port = $ports[0]
  Start-Sleep -Milliseconds 800   # let enumeration settle
  if (Flash-Reporting $port) { $done++ } else { $fail++ }
  Write-Host ("---- total OK: {0}   failed: {1}   (unplug this board for the next) ----" -f $done, $fail) -ForegroundColor Cyan
  do { Start-Sleep -Milliseconds 500 } while (@(Get-FtdiPorts) -contains $port)
}
