param([string]$FramePath = 'artifacts/dashboard-frame.json', [string]$OutputPath = 'artifacts/dashboard-preview.png')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$frame = Get-Content -LiteralPath $FramePath -Raw | ConvertFrom-Json
$cellWidth = 9
$lineHeight = 20
$bitmap = [System.Drawing.Bitmap]::new([int]($frame.columns * $cellWidth + 24), [int]($frame.rows * $lineHeight + 20))
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.Clear([System.Drawing.Color]::FromArgb(12,17,27))
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$font = [System.Drawing.Font]::new('Consolas',11,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Point)
$boldFont = [System.Drawing.Font]::new('Consolas',11,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Point)
$format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$format.FormatFlags = [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
$row = 0
foreach ($line in $frame.lines) {
    $col = 0
    $ink = [System.Drawing.Color]::FromArgb(228,236,247)
    $strong = $false
    foreach ($part in [regex]::Split($line, '(\x1b\[[0-?]*[ -/]*[@-~])')) {
        if ($part.StartsWith([string][char]27,[System.StringComparison]::Ordinal)) {
            if ($part -match '38;2;(\d+);(\d+);(\d+)m') { $ink = [System.Drawing.Color]::FromArgb([int]$Matches[1],[int]$Matches[2],[int]$Matches[3]) }
            elseif ($part -match '\[39m') { $ink = [System.Drawing.Color]::FromArgb(228,236,247) }
            elseif ($part -match '\[1m') { $strong = $true }
            elseif ($part -match '\[22m') { $strong = $false }
            continue
        }
        $brush = [System.Drawing.SolidBrush]::new($ink)
        $face = if ($strong) { $boldFont } else { $font }
        foreach ($letter in $part.ToCharArray()) { $g.DrawString([string]$letter,$face,$brush,[single](12+$col*$cellWidth),[single](10+$row*$lineHeight),$format); $col++ }
        $brush.Dispose()
    }
    $row++
}
$bitmap.Save((Join-Path (Get-Location) $OutputPath),[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $font.Dispose(); $boldFont.Dispose(); $bitmap.Dispose(); $format.Dispose()
