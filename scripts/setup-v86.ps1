$dest = "public/v86"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$files = @(
    @{ Name = "v86.wasm"; Url = "https://copy.sh/v86/build/v86.wasm" },
    @{ Name = "seabios.bin"; Url = "https://copy.sh/v86/bios/seabios.bin" },
    @{ Name = "vgabios.bin"; Url = "https://copy.sh/v86/bios/vgabios.bin" },
    @{ Name = "buildroot-bzimage68.bin"; Url = "https://copy.sh/v86/images/buildroot-bzimage68.bin" }
)

foreach ($file in $files) {
    $path = Join-Path $dest $file.Name
    if (-Not (Test-Path $path)) {
        Write-Host "downloading $($file.Name)..."
        try {
            Invoke-WebRequest -Uri $file.Url -OutFile $path -UseBasicParsing
        } catch {
            Write-Host "  Failed from copy.sh, trying unpkg..."
            $altUrl = "https://unpkg.com/v86@latest/$($file.Name -replace 'buildroot-bzimage68.bin','images/buildroot-bzimage68.bin' -replace 'seabios.bin','bios/seabios.bin' -replace 'vgabios.bin','bios/vgabios.bin' -replace 'v86.wasm','build/v86.wasm')"
            Invoke-WebRequest -Uri $altUrl -OutFile $path -UseBasicParsing
        }
    } else {
        Write-Host "$($file.Name) already exists"
    }
}

Write-Host "`nv86 Assets in $dest/"
Get-ChildItem $dest | Format-Table Name, Length


