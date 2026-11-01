# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/),
certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

The Windows build of Volt IDE: the application (`Volt IDE.exe`), the bundled
`volt` command-line tool (`volt.exe`), and the installer
(`Volt IDE Setup <version>.exe`). These are built from this repository and
[volt-cli](https://github.com/PhilemonChiro/volt-cli) by the GitHub Actions
workflow [`.github/workflows/windows.yml`](.github/workflows/windows.yml) and
signed only after that build succeeds. Nothing built outside that workflow is
signed with this certificate.

Signed releases are published at <https://voltembedded.com/#download> and
<https://dl.voltembedded.com/ide/>.

## Team roles

- Committers and reviewers: [Philemon Chiro](https://github.com/PhilemonChiro)
- Approvers: [Philemon Chiro](https://github.com/PhilemonChiro)

Every signing request is approved manually by an approver before the
certificate is used.

## Privacy

Volt IDE sends anonymous usage statistics and crash reports, both on by
default and each can be turned off in Settings › Privacy. It never sends your
code, files or project names. Full details, including every other connection
the IDE makes: <https://voltembedded.com/privacy>.
