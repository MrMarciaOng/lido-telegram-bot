require("dotenv").config();
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const cron = require("node-cron");
const dayjs = require("dayjs");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const token = process.env.TELEGRAM_BOT_TOKEN;
let isScheduleActive = false;
if (!token) {
  console.error("Error: TELEGRAM_BOT_TOKEN is not set in the .env file.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `Hello! 🤖 I'm your Lido Staking Pool Bot. Here's what I can do for you:
    \n/start - 🚀 Get an introduction and see available commands.
    \n/query Wallet_ADDRESS - 📊 Get the latest transactions and stats for a Lido staking pool address.
    \n/register Wallet_ADDRESS - 📌 Register your address to receive updates on the latest rewards.
    \n/deregister - ❌ Stop receiving updates by deregistering your address.
    \nNow, you can send me /query followed by your Wallet_ADDRESS to get started!`
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
  const address = match[1].trim(); // trim to remove any leading/trailing white spaces

  // Validate Ethereum address
  if (!isValidEthAddress(address)) {
    bot.sendMessage(chatId, `Invalid Ethereum address: ${address}`);
    return;
  }

  try {
    // Check if a record with the same user_id, chat_id, and wallet_address already exists
    const selectResult = await pool.query(
      "SELECT * FROM telegram_lido_tracking WHERE user_id = $1 AND chat_id = $2 AND wallet_address = $3",
      [userId, chatId, address]
    );

    if (selectResult.rowCount > 0) {
      // If a record is found, inform the user
      bot.sendMessage(
        chatId,
        `You have already registered the wallet address: ${address}`
      );
    } else {
      const id = uuidv4();
      // If no record is found, insert a new one
      await pool.query(
        "INSERT INTO telegram_lido_tracking (id, user_id, wallet_address, chat_id) VALUES ($1, $2, $3, $4)",
        [id, userId, address, chatId]
      );
      bot.sendMessage(
        chatId,
        `You have successfully registered the wallet address: ${address}`
      );
    }
  } catch (error) {
    console.error(error);
    bot.sendMessage(
      chatId,
      `Error registering wallet address: ${error.message}`
    );
  }
});
function isValidEthAddress(address) {
  return /^(0x)[0-9A-Fa-f]{40}$/.test(address);
}

let hasRebasedToday = false;
let resetRebaseCronJob;
let rebaseCronJob;
bot.onText(/\/startBot/i, async (msg) => {
  if (!checkAdmin(msg)) {
    return;
  }
  startCronJobs();
  const chatId = msg.chat.id;
  const reply = `starting rewards schedule for all users`;
  bot.sendMessage(chatId, reply, {
    message_thread_id: msgThreadId,
  });
  const address = process.env.adminWalletAddress;

  const url = `https://stake.lido.fi/api/rewards?address=${address}&currency=usd&onlyRewards=false&archiveRate=true&skip=0&limit=10`;
  const response = await axios.get(url);
  const data = response.data;

  const short_message = formatSimpleLidoStatsMessage(data);
  bot.sendMessage(chatId, short_message, {
    parse_mode: "Markdown",
  });
});

function startCronJobs() {
  if (isScheduleActive) {
    console.log("Cron job is already running, resetting hasRebasedToday");
    rebaseCronJob.stop();
    resetRebaseCronJob.stop();
  }
  console.log("Starting cron jobs");
  // Schedule a task to run every day at 12:00 UTC
  rebaseCronJob = cron.schedule(
    "* 12-13 * * *",
    async () => {
      console.log(
        "Running a task every day at 12:00 UTC to rebase successfully"
      );
      if (hasRebasedToday) return;
      const rebaseResults = await getStEthApr();
      //check if rebase has happened today
      if (rebaseResults.formattedDate.isSame(dayjs(), "day")) {
        hasRebasedToday = true;
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
                bot.sendMessage(chatId, short_message, {
                  parse_mode: "Markdown",
                });
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
      }
    },
    {
      scheduled: true,
      timezone: "UTC",
    }
  );

  // schedule a task to check if rebase has happened then turn hasRebasedToday to false
  resetRebaseCronJob = cron.schedule(
    "* 14 * * *",
    async () => {
      if (hasRebasedToday === false) return;
      console.log(
        "Running a task every day at 13:00 UTC to reset hasRebasedToday"
      );
      hasRebasedToday = false;
    },
    {
      scheduled: true,
      timezone: "UTC",
    }
  );
  isScheduleActive = true;
}

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

  const firstEvent = events.find((event) => event.type === "reward");
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

async function getStEthApr() {
  const url = "https://eth-api.lido.fi/v1/protocol/steth/apr/last";

  try {
    const response = await axios.get(url);
    const { timeUnix, apr } = response.data.data;

    const formattedDate = dayjs.unix(timeUnix);

    console.log("APR:", apr);
    console.log("Time (yyyy-mm-dd):", formattedDate);
    return { apr, formattedDate };
  } catch (error) {
    console.error("Error fetching APR:", error);
  }
}

// Check if admin
function checkAdmin(msg) {
  // Usernames are case sensitive
  const admins = ["Mr_Marcia_Ong"];
  const chatId = msg.chat.id;
  const msgThreadId = msg.message_thread_id;
  const messageId = msg.message_id;
  if (!admins.includes(msg.from.username)) {
    bot.sendMessage(chatId, "You are not an admin to execute this command", {
      message_thread_id: msgThreadId,
      reply_to_message_id: messageId,
    });
    return false;
  }
  return true;
}

bot.onText(/\/stopBot/i, async (msg) => {
  if (!checkAdmin(msg)) {
    return;
  }
  const chatId = msg.chat.id;
  const msgThreadId = msg.message_thread_id;
  const reply = `Stopping rewards schedule.`;
  bot.sendMessage(chatId, reply, {
    message_thread_id: msgThreadId,
  });
  chatIdCronStatusMap[chatId] = false;
  console.log("Cron job has been stopped");
  resetRebaseCronJob.stop();
  rebaseCronJob.stop();
});

startCronJobs();
