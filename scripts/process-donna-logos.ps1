$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function Clamp([double]$value, [double]$min, [double]$max) {
    if ($value -lt $min) { return $min }
    if ($value -gt $max) { return $max }
    return $value
}

function Get-Hsv([System.Drawing.Color]$color) {
    $r = $color.R / 255.0
    $g = $color.G / 255.0
    $b = $color.B / 255.0

    $max = [Math]::Max($r, [Math]::Max($g, $b))
    $min = [Math]::Min($r, [Math]::Min($g, $b))
    $delta = $max - $min

    $h = 0.0
    if ($delta -ne 0) {
        if ($max -eq $r) {
            $h = 60 * ((($g - $b) / $delta) % 6)
        }
        elseif ($max -eq $g) {
            $h = 60 * ((($b - $r) / $delta) + 2)
        }
        else {
            $h = 60 * ((($r - $g) / $delta) + 4)
        }
    }

    if ($h -lt 0) {
        $h += 360
    }

    $s = if ($max -eq 0) { 0.0 } else { $delta / $max }
    $v = $max

    return @{
        H = $h
        S = $s
        V = $v
    }
}

function Get-Alpha([System.Drawing.Color]$color) {
    $hsv = Get-Hsv $color
    $brightness = ($color.R + $color.G + $color.B) / (255.0 * 3.0)

    $valueScore = Clamp (($hsv.V - 0.54) / 0.40) 0 1
    $satScore = Clamp ((0.55 - $hsv.S) / 0.55) 0 1
    $brightScore = Clamp (($brightness - 0.60) / 0.35) 0 1

    $alpha = [Math]::Pow(($valueScore * 0.55) + ($brightScore * 0.45), 1.2) * $satScore

    if (($hsv.S -lt 0.10) -and ($hsv.V -gt 0.90)) {
        $alpha = [Math]::Max($alpha, 0.98)
    }

    return [int](Clamp $alpha 0 1 * 255)
}

function Export-Variant($sourcePath, $whitePath, $darkPath, [System.Drawing.Color]$darkColor) {
    $bitmap = [System.Drawing.Bitmap]::new($sourcePath)
    try {
        $whiteBitmap = [System.Drawing.Bitmap]::new($bitmap.Width, $bitmap.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $darkBitmap = [System.Drawing.Bitmap]::new($bitmap.Width, $bitmap.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

        try {
            for ($y = 0; $y -lt $bitmap.Height; $y++) {
                for ($x = 0; $x -lt $bitmap.Width; $x++) {
                    $pixel = $bitmap.GetPixel($x, $y)
                    $alpha = Get-Alpha $pixel

                    $whiteBitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
                    $darkBitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $darkColor.R, $darkColor.G, $darkColor.B))
                }
            }

            $whiteBitmap.Save($whitePath, [System.Drawing.Imaging.ImageFormat]::Png)
            $darkBitmap.Save($darkPath, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $whiteBitmap.Dispose()
            $darkBitmap.Dispose()
        }
    }
    finally {
        $bitmap.Dispose()
    }
}

$outputDir = Join-Path $PSScriptRoot '..\assets\brand'
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$variants = @(
    @{
        Source = 'C:\Users\victo\Downloads\ChatGPT Image 27 de abr. de 2026, 09_10_30 (2).png'
        BaseName = 'donna-monogram'
    },
    @{
        Source = 'C:\Users\victo\Downloads\ChatGPT Image 27 de abr. de 2026, 09_10_30 (3).png'
        BaseName = 'donna-stacked'
    },
    @{
        Source = 'C:\Users\victo\Downloads\ChatGPT Image 27 de abr. de 2026, 09_10_30 (1).png'
        BaseName = 'donna-horizontal'
    },
    @{
        Source = 'C:\Users\victo\Downloads\ChatGPT Image 27 de abr. de 2026, 09_10_25.png'
        BaseName = 'donna-badge'
    }
)

$darkColor = [System.Drawing.Color]::FromArgb(43, 25, 15)

foreach ($variant in $variants) {
    $whitePath = Join-Path $outputDir "$($variant.BaseName)-white.png"
    $darkPath = Join-Path $outputDir "$($variant.BaseName)-dark.png"

    Export-Variant `
        -sourcePath $variant.Source `
        -whitePath $whitePath `
        -darkPath $darkPath `
        -darkColor $darkColor
}

Get-ChildItem $outputDir -File | Select-Object Name, FullName
