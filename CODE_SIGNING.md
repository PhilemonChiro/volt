# Code signing

The Windows build of Volt IDE is not code-signed yet, so Windows SmartScreen
may warn when the installer first runs (choose **More info › Run anyway**).
The macOS build is signed and notarised by Apple.

Windows installers are built from this repository and
[volt-cli](https://github.com/PhilemonChiro/volt-cli) by the GitHub Actions
workflow [`.github/workflows/windows.yml`](.github/workflows/windows.yml) and
published at <https://voltembedded.com/#download> and
<https://dl.voltembedded.com/ide/>.
