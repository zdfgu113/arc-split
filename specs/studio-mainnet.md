Apply the supplied mainnet revision to the existing Arc Split workspace, preserving every attached source file exactly.

The local encrypted-wallet path now supports owner-approved deployment on Arc Mainnet, chain 5042, and a conservative cumulative five-USDC budget based on persisted nonce reservations. The browser-wallet path checks a five-USDC per-transaction cap. Mainnet and testnet deployment recovery are stored separately. JSON network coercion is rejected before signing. Zero balances fail before requesting a signature.

The owner has already confirmed the real mainnet deployment and a 1.98 USDC split in the Windows native wallet window. The attached docs/mainnet-deployment.json and docs/mainnet-split.json are independently verified PUBLIC evidence, not credentials. The split returned 1.386 USDC to the payer and sent 0.594 USDC to a separate owner-controlled wallet. Do not claim that these local signatures occurred inside Studio.

Run npm test (28 tests) and npm run build in Studio. All automatic signing tests must remain on isolated local EVM networks using ephemeral test wallets. Never run the Windows GUI or localhost signing service in the cloud. Do not deploy, bridge, sign a real transaction, request credentials, or inspect any secret directory. None is attached. Report the actual test/build results and keep the normal static preview available.
