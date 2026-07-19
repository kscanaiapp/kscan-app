param(
    [string]$TargetPath = "C:\Users\jsmit\kscan-google-glasses-canonical"
)

# Verify the Google Glasses workspace structure
$errors = 0

$requiredFiles = @(
    "README.md",
    "QA_REPORT.md",
    "android-xr/app/build.gradle.kts",
    "android-xr/app/src/main/java/com/kscan/glasses/KScanApplication.kt",
    "android-xr/app/src/main/java/com/kscan/glasses/MainActivity.kt",
    "android-xr/app/src/main/java/com/kscan/glasses/privacy/FaceMasker.kt",
    "android-xr/app/src/main/java/com/kscan/glasses/privacy/PrivacyImageSanitizer.kt",
    "android-xr/app/src/main/java/com/kscan/glasses/state/KScanViewModel.kt",
    "android-xr/app/src/main/java/com/kscan/glasses/bridge/CaptureException.kt",
    "docs/google/ARCHITECTURE.md",
    "docs/google/SETUP.md",
    "docs/google/BUILD.md",
    "docs/google/TEST.md",
    "docs/google/MOBILE_APP_BOUNDARY.md",
    "qa/google-glasses-structure-cleanup-2026-06-18.md",
    ".gitignore"
)

foreach ($file in $requiredFiles) {
    $fullPath = Join-Path $TargetPath $file
    if (Test-Path $fullPath) {
        Write-Host "[PASS] $file" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $file" -ForegroundColor Red
        $errors++
    }
}

$excludedDirs = @("build", ".gradle", ".idea", ".kotlin", "out", "dist", "node_modules")
foreach ($dir in $excludedDirs) {
    $found = Get-ChildItem -Path $TargetPath -Recurse -Directory -Filter $dir -ErrorAction SilentlyContinue
    if ($found) {
        Write-Host "[WARN] Excluded directory found: $($found.FullName)" -ForegroundColor Yellow
    } else {
        Write-Host "[PASS] No '$dir' directory found" -ForegroundColor Green
    }
}

$excludedFiles = @("local.properties", ".env", ".env.local")
foreach ($pattern in $excludedFiles) {
    $found = Get-ChildItem -Path $TargetPath -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue
    if ($found) {
        Write-Host "[WARN] Excluded file found: $($found.FullName)" -ForegroundColor Yellow
    } else {
        Write-Host "[PASS] No '$pattern' file found" -ForegroundColor Green
    }
}

if ($errors -eq 0) {
    Write-Host "`nVerification complete: PASS" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`nVerification complete: FAIL ($errors missing files)" -ForegroundColor Red
    exit 1
}
