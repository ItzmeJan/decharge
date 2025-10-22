const { 
  Connection, 
  Keypair, 
  PublicKey,
  Transaction,
  sendAndConfirmTransaction
} = require('@solana/web3.js');
const { 
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const fs = require('fs').promises;

const SOLANA_RPC = 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

async function createRewardToken() {
  console.log('🚀 Creating EV Charging Reward Token on Solana Devnet...\n');
  
  // Generate or load server keypair
  let serverKeypair;
  try {
    const keypairData = JSON.parse(await fs.readFile('./server-keypair.json', 'utf8'));
    serverKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
    console.log('✅ Loaded existing server keypair');
  } catch (e) {
    serverKeypair = Keypair.generate();
    await fs.writeFile('./server-keypair.json', JSON.stringify(Array.from(serverKeypair.secretKey)));
    console.log('✅ Generated new server keypair');
  }
  
  console.log('📍 Server Public Key:', serverKeypair.publicKey.toString());
  console.log('\n⚠️  Please fund this wallet with devnet SOL at:');
  console.log('   https://faucet.solana.com/');
  console.log('   or use: solana airdrop 2 ' + serverKeypair.publicKey.toString() + ' --url devnet\n');
  
  // Check balance
  const balance = await connection.getBalance(serverKeypair.publicKey);
  console.log('💰 Current Balance:', balance / 1e9, 'SOL');
  
  if (balance < 0.5e9) {
    console.log('\n❌ Insufficient balance. Need at least 0.5 SOL for token creation.');
    console.log('   Please fund the wallet and run this script again.');
    return;
  }
  
  console.log('\n📝 Creating token mint...');
  
  // Create the token mint
  const mint = await createMint(
    connection,
    serverKeypair,
    serverKeypair.publicKey, // mint authority
    serverKeypair.publicKey, // freeze authority
    9 // decimals
  );
  
  console.log('✅ Token Mint Created:', mint.toString());
  
  // Create token account for server
  console.log('\n📝 Creating token account for server...');
  const serverTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    serverKeypair,
    mint,
    serverKeypair.publicKey
  );
  
  console.log('✅ Server Token Account:', serverTokenAccount.address.toString());
  
  // Mint initial supply (1 million tokens for rewards)
  console.log('\n📝 Minting initial supply...');
  const mintAmount = 1_000_000 * Math.pow(10, 9); // 1 million tokens
  
  await mintTo(
    connection,
    serverKeypair,
    mint,
    serverTokenAccount.address,
    serverKeypair.publicKey,
    mintAmount
  );
  
  console.log('✅ Minted 1,000,000 reward tokens to server account');
  
  // Save configuration
  const config = {
    tokenMint: mint.toString(),
    serverPublicKey: serverKeypair.publicKey.toString(),
    serverTokenAccount: serverTokenAccount.address.toString(),
    decimals: 9,
    initialSupply: 1_000_000,
    network: 'devnet',
    rpc: SOLANA_RPC
  };
  
  await fs.writeFile('./token-config.json', JSON.stringify(config, null, 2));
  console.log('\n✅ Configuration saved to token-config.json');
  
  // Create .env template
  const envContent = `SOLANA_RPC=${SOLANA_RPC}
REWARD_TOKEN_MINT=${mint.toString()}
SERVER_KEYPAIR_PATH=./server-keypair.json
PORT=3000`;
  
  await fs.writeFile('.env.example', envContent);
  console.log('✅ Environment template saved to .env.example');
  
  console.log('\n🎉 Token creation complete!');
  console.log('\n📋 Next steps:');
  console.log('1. Copy .env.example to .env');
  console.log('2. Update your .env file with the token mint address above');
  console.log('3. Start the server with: node server.js');
  console.log('\n💡 Token Details:');
  console.log('   Mint Address:', mint.toString());
  console.log('   View on Solscan:', `https://solscan.io/token/${mint.toString()}?cluster=devnet`);
  console.log('   View on Solana Explorer:', `https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`);
}

// Run the script
createRewardToken().catch(console.error);