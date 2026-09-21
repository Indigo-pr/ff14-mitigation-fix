<#
.SYNOPSIS
    .env を読み込んで、現在のプロセスの環境変数にセットする。

.DESCRIPTION
    tools/fflogs_unmitigated.py は os.environ を直接読むため、
    実行前にこのスクリプトを「ドットソース」して環境変数を用意する。

    ドットソース（先頭の "." ）が必須。普通に実行すると子プロセスで
    環境変数がセットされ、戻ってきた時には消えている。

    このファイル自体に秘密情報は入っていない（値は .env 側にある）ので
    コミットしてよい。設定した値は画面に出力しない（変数名だけ出す）。

.EXAMPLE
    . .\tools\load-env.ps1
    python tools/fflogs_unmitigated.py 9

.EXAMPLE
    # 別のファイルから読む場合
    . .\tools\load-env.ps1 -Path .env.staging
#>

param(
    [string]$Path
)

if (-not $Path) {
    $Path = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
}

if (-not (Test-Path $Path)) {
    Write-Error "環境変数ファイルが見つかりません: $Path`n.env.example をコピーして値を入れてください。"
    return
}

$loaded = @()

Get-Content $Path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { return }

    $name  = $matches[1]
    $value = $matches[2].Trim()

    # 値を囲むクォートがあれば外す
    if ($value.Length -ge 2 -and
        (($value.StartsWith('"')  -and $value.EndsWith('"')) -or
         ($value.StartsWith("'")  -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    # 空値は「未設定」とみなす（雛形をそのままコピーした状態を弾く）
    if ($value -eq '') { return }

    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    $loaded += $name
}

if ($loaded.Count -eq 0) {
    Write-Warning "$Path から読み込める変数がありませんでした。値が空のままかもしれません。"
} else {
    # 値は絶対に出力しない。変数名だけ。
    Write-Host ("環境変数を設定しました: " + ($loaded -join ', '))
}
