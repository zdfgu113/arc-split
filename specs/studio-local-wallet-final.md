Apply the attached final small revision to the existing Arc Split app without changing any supplied files.

The frontend now refreshes its displayed local-wallet balance after deployment, payment, and receipt checks. The Windows wallet-creation window also supports a separate encrypted test-recipient wallet. Existing protected wallet-directory ACLs are checked and reused; new directories are restricted with the native Windows icacls tool to avoid requesting unrelated security privileges. The test-recipient file never overwrites the payer wallet.

Run the static build, then the 25 Node tests. Do not run Windows GUI scripts or the localhost signer in the cloud. Do not access any real wallet, credentials or secret directory; no such file is attached. All automatic signing tests use temporary wallets and a simulated local chain. Preserve the standard demo/browser-wallet preview. Report actual results and avoid extra changes.
