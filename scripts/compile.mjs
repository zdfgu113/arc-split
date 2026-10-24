import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import solc from 'solc';

export async function compileContracts(extraSources = {}) {
  const input = {
    language: 'Solidity',
    sources: { 'ArcSplit.sol': { content: await readFile(new URL('../contracts/ArcSplit.sol', import.meta.url), 'utf8') }, ...extraSources },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  };
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (result.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return result.contracts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contracts = await compileContracts();
  const contract = contracts['ArcSplit.sol'].ArcSplit;
  const artifact = { compiler: solc.version(), abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, deployedBytecode: `0x${contract.evm.deployedBytecode.object}` };
  await mkdir(new URL('../src/', import.meta.url), { recursive: true });
  await writeFile(new URL('../src/artifact.json', import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
  console.log(`Compiled ArcSplit with ${solc.version()}; ${contract.evm.bytecode.object.length / 2} byte creation code.`);
}
