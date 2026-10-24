Continue the existing Arc Split / 同账 app. The attached files are the tested local-wallet revision. Preserve the supplied frontend, contract and signing validation exactly. Keep the existing visual design.

The static frontend still works with an ordinary browser extension. A separate Windows-only localhost launcher serves the same production bundle and injects the local-wallet marker. Its native WPF dialog asks the owner to review each exact transaction and enter their password. The private keystore lives outside the repository and is NEVER attached. There is no automatic signing or persistent unlocked key. Do not request any password, private key, seed, credential file, wallet file or secret folder.

Replace the corresponding project files with the supplied versions. Install the pinned dependencies with scripts disabled, build first, then run the Node tests. Do not launch a Windows GUI or the localhost signing server in the cloud. Do not connect wallets, deploy contracts, request funds, submit signatures or send transactions. The tests generate temporary test wallets and use a local simulated chain only. There are now 25 Node tests.

One real Arc testnet deployment was independently confirmed locally after the owner approved it in the native window. This is testnet evidence, not mainnet evidence or proof of prize eligibility. The app has not been submitted to a hackathon.

Report the actual build/test output and any files you changed. Do not introduce other dependencies, redesign the interface or claim to have tested native Windows signing in the cloud. Keep the app preview usable in demo mode and retain the standard browser-wallet path there.
