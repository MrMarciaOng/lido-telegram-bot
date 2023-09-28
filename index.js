require("dotenv").config();
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const cron = require("node-cron");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Error: TELEGRAM_BOT_TOKEN is not set in the .env file.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "Hello! Send me /query Wallet_ADDRESS to get the latest transactions and stats."
  );
});

bot.onText(/\/query\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const address = match[1].trim(); // trim to remove any leading/trailing white spaces

  const url = `https://stake.lido.fi/api/rewards?address=${address}&currency=usd&onlyRewards=false&archiveRate=true&skip=0&limit=10`;

  // console.log(`Address: ${address}`); // Log the address
  // console.log(`URL: ${url}`); // Log the URL

  try {
    console.log(`Fetching data from ${url}`);
    const response = await axios.get(url); // Use axios.get instead of fetch
    const data = response.data; // Directly access the data property instead of calling response.json()
    // console.log(data);
    // Format the response data as you need
    const message = formatLidoStatsMessage(data);

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

    // const short_message = formatSimpleLidoStatsMessage(data);
    // bot.sendMessage(chatId, short_message, { parse_mode: "Markdown" });
  } catch (error) {
    bot.sendMessage(chatId, `Error querying Lido Staking Pool: ${error}`);
  }
});

bot.onText(/\/register\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  console.log(userId);
  const address = match[1].trim(); // trim to remove any leading/trailing white spaces
  const id = uuidv4();

  try {
    await pool.query(
      "INSERT INTO telegram_lido_tracking (id, user_id, wallet_address, chat_id) VALUES ($1, $2, $3, $4)",
      [id, userId, address, chatId]
    );
    bot.sendMessage(
      chatId,
      `You have successfully registered the wallet address: ${address}`
    );
  } catch (error) {
    if (error.constraint === "telegram_lido_tracking_user_id_key") {
      bot.sendMessage(chatId, `You have already registered a wallet address.`);
    } else {
      console.error(error);
      bot.sendMessage(
        chatId,
        `Error registering wallet address: ${error.message}`
      );
    }
  }
});
// Schedule a task to run every day at 12:15 UTC
cron.schedule(
  "15 12 * * *",
  async () => {
    console.log("Running a task every day at 12:15 UTC");

    try {
      // Start a connection from the pool
      const client = await pool.connect();

      try {
        // Fetch all users from the database
        const result = await client.query(
          "SELECT * FROM telegram_lido_tracking"
        );
        const users = result.rows;
        console.log("users to notify", users.length);
        // For each user, fetch the latest block rewards and send a Telegram message
        for (const user of users) {
          try {
            const address = user.wallet_address;
            const chatId = user.chat_id; // Use the stored chatId here

            const url = `https://stake.lido.fi/api/rewards?address=${address}&currency=usd&onlyRewards=false&archiveRate=true&skip=0&limit=10`;
            const response = await axios.get(url);
            const data = response.data;

            const short_message = formatSimpleLidoStatsMessage(data);
            bot.sendMessage(chatId, short_message, { parse_mode: "Markdown" });
          } catch (error) {
            console.error(`Error notifying user ${user.user_id}: ${error}`);
          }
        }
      } finally {
        // Release the client back to the pool
        client.release();
      }
    } catch (error) {
      console.error("Error fetching users from the database:", error);
    }
  },
  {
    scheduled: true,
    timezone: "UTC",
  }
);

bot.onText(/\/deregister/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const res = await pool.query(
      "DELETE FROM telegram_lido_tracking WHERE user_id = $1 RETURNING *",
      [userId]
    );

    if (res.rows.length === 0) {
      bot.sendMessage(chatId, "You are not registered.");
      return;
    }
    const addressString = res.rows.map((row) => row.wallet_address).join(", ");
    bot.sendMessage(
      chatId,
      `You have successfully deregistered the wallet address: ${addressString}`
    );
  } catch (error) {
    console.error(error);
    bot.sendMessage(
      chatId,
      `Error deregistering wallet address: ${error.message}`
    );
  }
});

bot.on("polling_error", (error) => {
  console.log(error);
});

function formatLidoStatsMessage(data) {
  // Extracting required information from data
  const { events, totals, averageApr, ethToStEthRatio, stETHCurrencyPrice } =
    data;

  const firstEvent = events[0];
  const firstEventInfo = `
ID: ${firstEvent.id}
APR: ${parseFloat(firstEvent.apr).toFixed(6)}%
Block: ${firstEvent.block}
Type: ${firstEvent.type}
Rewards: ${formatNumber(firstEvent.rewards, 8)} ETH
Change: ${formatNumber(firstEvent.change, 8)} ETH
currencyChange: $${parseFloat(firstEvent.currencyChange).toFixed(6)}
  `;

  // Formatting totals object
  const totalsInfo = `
Total ETH Rewards: ${formatNumber(totals.ethRewards, 8)} ETH
Total Currency Rewards: $${parseFloat(totals.currencyRewards).toFixed(6)}
  `;

  // Formatting other information
  const otherInfo = `
Average APR: ${parseFloat(averageApr).toFixed(6)}%
ETH to stETH Ratio: ${parseFloat(ethToStEthRatio).toFixed(6)}
stETH Currency Price: ${parseFloat(stETHCurrencyPrice.eth).toFixed(
    6
  )} ETH / $${parseFloat(stETHCurrencyPrice.usd).toFixed(2)} USD
  `;

  // Constructing the final message
  const finalMessage = `
🔍 *Lido Staking Pool Overview*

📊 *Latest Event:*
${firstEventInfo}

💰 *Totals:*
${totalsInfo}

📈 *Other Information:*
${otherInfo}
  `;

  return finalMessage;
}

function formatSimpleLidoStatsMessage(data) {
  // Extracting required information from data
  const { events, totals } = data;

  const firstEvent = events[0];
  console.log(firstEvent);
  const latestRewardsInfo = `
Latest Rewards: ${formatNumber(firstEvent.rewards, 8)} ETH
Currency Change: $${parseFloat(firstEvent.currencyChange).toFixed(6)}
  `;

  const totalsInfo = `
Total ETH Rewards: ${formatNumber(totals.ethRewards)} ETH
Total Currency Rewards: $${parseFloat(totals.currencyRewards).toFixed(6)}
  `;

  const finalMessage = `
💰 *Latest Lido Rewards*
  ${latestRewardsInfo}
  
🔥 *Totals:*
  ${totalsInfo}
  `;
  return finalMessage;
}

function formatNumber(num, dp = 6) {
  return parseFloat((Number(num) / 10 ** 18).toFixed(dp));
}
