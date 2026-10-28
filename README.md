# StrafeClicker

A CS2 case-opening simulator. Play money only: no deposits, no withdrawals, nothing real.

- **Real cases & capsules**: all 42 CS2 weapon cases plus 229 sticker and autograph capsules, with their actual contents, float ranges, StatTrak eligibility and Doppler phases. Capsules open without a key.
- **Real odds**: Valve's published rates (Mil-Spec 79.92%, Restricted 15.98%, Classified 3.20%, Covert 0.64%, Rare Special 0.26%), 10% StatTrak, community-measured float distribution.
- **Live market prices**: the server refreshes every wear / StatTrak / phase price from Skinport (lowest current listing) once a minute, on the minute. Every browser sees the same countdown and gets the update pushed at the same moment; clients can't trigger or delay it.
- **Price changes**: each price update that moves your inventory shows a short message ("Prices: inventory +$0.42 (AK-47 | Redline +$0.30)"). What changed while the site was closed goes into the welcome-back popup, together with any offline income.
- **Price history graphs** for every item variant (click any item), recorded by the server.
- **Accounts**: sign up with a username and password (no guest accounts). Balance, inventory and every roll live on the server in SQLite; the browser only ever sees outcomes.
- **Clicker**: click to earn money ($0.05 per click to start). Up to 12 clicks per second pay in full; faster than that, each click is worth exponentially less (14 cps pays 50%, 17 cps 18%, 22 cps 3%). The server works this out from the click timings, and won't accept a timeline that runs ahead of real time.
- **Achievements**: 23 goals named in tiers (Clicker I to IV, Unboxer I to III, ...) (clicks, cases opened, rare drops, upgrades, each game, net worth), each with a one-off cash reward. The server checks them after every action; an unlocked one shows a red count on the Achievements tab and its reward is collected with Claim (or Claim all). They stay unlocked through "Reset everything" so rewards can't be farmed.
- **Plinko**: 8, 12 or 16 rows at low, medium or high risk, with Stake's multiplier tables (each pays back about 99% on average). The server picks the path; several balls can be in the air at once.
- **Flashbang**: a crash game with one round for everyone. A flashbang rides the multiplier curve (e^(0.00006 × ms): 2x after about 12 s, 10x after 38 s) until it pops; cash out before then, by hand or with an auto target. The crash point has a 1% edge (P(at least x) = 0.99 / x, capped at 1000x) and stays on the server until the pop. Rounds are 10 s apart; bets placed while a round runs (if you're not riding it) go into the next one. Everyone on the page, and anyone still riding the round wherever they are on the site, is flashed at the same moment: full white for 1.2 s, fading over 3.3 s, with a bang and ear ringing. Stakes are held in the database, so a restart refunds whatever was riding.
- **B-hop**: jump along a lane of bhop blocks and cash out before one gives way. Pick a difficulty: each jump lands safely 90% (Easy, 24 blocks), 80% (Medium, 20), 60% (Hard, 15) or 40% (Expert, 10) of the time, and the multiplier after k jumps is 0.99 / p^k. The breaking block is decided when the run starts and kept on the server; the browser only learns it by landing on it or when the run ends. Runs survive reloads. The jumper is `src/assets/ct-agent.webp`, keyed from a green-screen capture. Replace it with another picture of the same name (a green-screen `.png`/`.jpg` works too: it's keyed and cropped to the biggest figure in the browser).
- **Coinflip**: 1v1 with skins. Put up to 10 items on T or CT; whoever joins puts up items worth 90–110% as much and gets the other side, and the winner takes every item (no house cut). Public, friends only or private (code). Against a bot: win and you get your items back plus their value in cash; lose and the bot keeps them. Staked items are held by the server, so a restart returns them.
- **Jackpot**: everyone deposits skins (up to 10 per deposit, $0.10 minimum) into one pot. Once two players are in, the wheel spins after 45 s; each cent of deposited value is a ticket, and the winner takes every item. The wheel stops with the winning ticket under the pointer on every screen. Items are held by the server while in the pot (a restart returns them), and while you're the only one in you can take them back.
- **Roulette**: the classic CS-site wheel, one round for everyone: 15 numbers, 0 is green (pays 14x), 1–7 T and 8–14 CT (2x each; 93.3% back on average, as on those sites). 20 s of betting, a 6 s spin that lands on the same spot for everyone, 3 s for the result. Everyone's bets are listed per colour. Stakes are held in the database and refunded after a restart.
- **Defuse**: a 5×5 grid hiding 1–24 C4s. Reveal tiles and cash out before you hit one; after k safe tiles the multiplier is 0.99 / (chance of surviving k picks), so it pays back 99% like the other games. Bomb positions are drawn on the server when the round starts and only shown after it ends. Rounds survive reloads.
- **Case battles**: 2, 3 or 4 players open the same cases, one per round (up to 5 per battle to start, raised to 35 by the Battle size upgrade); the highest total value takes every item (a tie is settled at random). Battles are public, friends only, or private (joined with a 6-character code or invite link). Each player pays when they take a seat, the creator can fill empty seats with bots, and cancelling refunds everyone. When the last seat fills the server rolls everything and hands the items over; every browser then plays the rounds back on the same clock.
- **Friends**: add people by username from the friends button in the top bar; they accept or decline. Friends see your friends-only battles and show as online when they have the site open.
- **Profiles**: click any player's name (live wins, flashbang, battles, friends, trades) for a mini profile: display name, @username, join date, cases opened, battles won, achievements and best item, with Add friend / Trade / Profile buttons. Friends (and you) also see online status, balance and inventory worth, and the profile page (`#/u/<username>`) shows their whole inventory. Your own profile is where you set a display name (up to 24 characters); the username stays your login and what friends add you by. You can also pin up to 4 items to a **showcase** and pick a banner colour; both are shown to everyone, along with your biggest win and favourite game. Friends' online status updates live.
- **Trade**: swap items and cash with friends. Pick from both inventories, add cash on either side, send the offer; they accept or decline, you can cancel. Nothing is held while an offer is open: on accept the server checks both sides still have everything and moves it all in one transaction, or the offer fails. The Trade tab shows a red count of offers waiting for you.
- **Bot race**: one shared race for everyone. Each round the five bots get fresh chances, shown as odds that pay back 99%; 20 s of betting, then a race of about 10 s that looks the same on every screen (the server picks the winner by those chances and scripts every bot's path), then the result.
- **Auto mode** (Defuse and Plinko): switch the panel to Auto, set how many bets (or no limit), optional stop-at-profit / stop-at-loss amounts, and what happens to the bet after a win or a loss (back to the starting bet, or raised by a percentage). In Defuse you tap the tiles to reveal each round; the server plays each round in one go with the same odds as by hand. Stopping auto puts the bet back to what you started with.
- **Towers**: an endless climb. Each floor has 4 / 3 / 2 / 3 doors with 1 / 1 / 1 / 2 Ts (Easy / Medium / Hard / Expert); pick a safe door to go up, cash out whenever you like. After k floors the multiplier is 0.99 / (chance per floor)^k, capped at 1,000,000x. The Ts are placed only once you've picked, so nothing about the floors ahead exists to be found out.
- **Blackjack**: tables of up to four players against one dealer. The first bet starts a 12 s window for others to sit down; then everyone gets two cards and all players play their hand at the same time (hit, stand, or double on the first two cards) within 30 s; anyone still deciding then stands. The dealer turns the hole card and draws to 17 (stands on soft 17) one card at a time, the same on every screen. Blackjack pays 3:2, a win 1:1, a push returns the bet; the dealer peeks for blackjack. Six decks, no splits or insurance. You see your own hand plus the up to three others at your table. About 99% payback with perfect basic strategy.
- **Brackets**: tournaments for 4 or 8 players with an entry fee; the creator picks the game for each round (quarter-finals, semis, final): coinflip, high card, rock paper scissors (best of 3, both pick at once) or an unbox duel (both open the case you choose, the pricier drop goes through; nobody keeps the items). Seeding is random, matches in a round play at the same time, and the champion takes every fee. Public / friends / private, and the creator can fill empty seats with bots (a bot that wins keeps the pot for the house).
- **Rock paper scissors**: duels for balance, first to 2 round wins (ties replay). Both players pick at the same time within 10 s; the server keeps each pick hidden until both are in, and a player who runs out of time gets a random hand. The winner takes both stakes, no house cut. Public, friends only or private (code), and the creator can play a bot instead.
- **Bomb plant**: one shared round for everyone on a small top-down map. The T runs to A or B and plants, the CTs retake, and the bomb explodes or gets defused (four equally likely endings). Bet on the site (1.98x), on how it ends (1.98x), or on both at once (3.96x); 20 s of betting, about 9 s of round that plays the same on every screen, then the result.
- **Video poker**: Jacks or Better. Deal five cards, tap the ones to hold, draw once; paid by the 9/6 table in `POKER_HANDS` (`shared/game.js`): pair of jacks or better 1x, two pair 2x, three of a kind 3x, straight 4x, flush 6x, full house 9x, four of a kind 25x, straight flush 50x, royal flush 800x. 99.54% payback with perfect play. The deck is shuffled on the server and a dealt hand survives a reload.
- **Keno**: a 7×7 grid. Pick 1–10 tiles, the server draws 10 of the 49, and you're paid by how many of yours were hit (`KENO_TABLES` in `shared/game.js`; each row pays back about 99%).
- **Daily spin**: a free wheel once every 24 hours paying $0.25 to $100 into your balance (about $2.27 a day on average; prizes in `DAILY_PRIZES` in `shared/game.js`). A red dot in the sidebar shows when it's ready.
- **Layout**: the left sidebar has the main pages, then the games and the rewards (missions, daily spin, achievements, leaderboards) as two groups that fold up on their own when the screen isn't tall enough (click a group's title to fold or unfold it; that choice is remembered). The right column has live wins in the top third and the chat below; on smaller screens it's a drawer opened with the speech-bubble button in the top bar, which also counts unread messages.
- **Chat**: a global chat under the live wins. Two commands:
  - `/rain <amount>` (the **Rain** button types it for you): your own money is split evenly among everyone else online right now. Everyone online sees it rain on their screen, bigger by log10 of the amount: $1–9 Drizzle, $10+ Shower, $100+ Downpour (rain streaks), $1,000+ Storm (lightning), $10,000+ Thunderstorm (the screen shakes), $100,000+ Monsoon. The chat shows how much was rained, on how many players, and how much you got.
  - `/pay <user> <amount>`: send money to one player. Only the two of you see it in the chat. The **Pay** button on any profile card types it for you.

  Amounts can be written as `50`, `$1,250.50` or `2k`. Messages are up to 200 characters, about one every second at most.
- **Clans**: start one for $25 with a name and a 2–4 character tag, which then shows before every member's name across the site. Clans are open (anyone joins) or by request (the owner accepts or declines), up to 20 members; the owner can kick, and leaving hands ownership to the longest-standing member (the last one out disbands it). Members get a Clan tab in the chat, and a /rain typed there only reaches online clan members. The Clans page ranks clans by what their members wagered this week.
- **Daily missions**: three random tasks every UTC day (one easy, one medium, one hard: open cases, click, wager, play or win rounds of a game, hit a multiplier) paying $1 / $2.50 / $5, claimed on the Missions page. The task list is in `server/missions.mjs`.
- **Leaderboards**: most wagered and biggest single win, today and this week (UTC, weeks start Monday), plus the richest players (balance + inventory). When a day or week ends, the top wagerers get the prizes set in the admin panel (default $25 / $10 / $5 daily, $100 / $50 / $25 weekly) and the chat announces them. The admin account isn't ranked.
- **Promo codes**: made in the admin panel, redeemed on the Missions page, once per player.
- **Live wins**: the right column shows notable items people unbox, upgrade into or win in battles (only items; casino payouts aren't posted). Knives, gloves and Covert items always show; otherwise an item needs to be worth $25+, or 10x what its case cost and $2+. A multi-open posts only its best item. Flood control: one entry per player per 15 s, and once 8 went out in a minute only $50+ items get through (knives, gloves and $100+ items skip both limits). The rules are at the top of `server/feed.mjs`. Entries wait until the reel has landed so they never spoil your own roll.
- **Upgrader**: stake up to 10 items for one pricier skin or sticker. Chance = your value ÷ target price × 90%, between 1% and 80%.
- **Upgrade tree**: an Obsidian-style graph (drag nodes, pan, zoom). Each node shows its icon and price; hover for details, click to pin and buy. Spend balance to open up to 5 cases at once, raise click value up to $1.00, raise offline income from $0.25 to $4.00 per hour, raise how many cases you can put in a case battle from 5 to 35, and raise the max bet from $10,000 to $25k / $50k / $100k / $250k / $1M and finally no limit. Levels and costs are in `PERKS` in `shared/game.js`.
- **Offline income**: time away (gaps of 5+ minutes, up to 12 hours) is paid out when you come back, with a welcome-back popup (which also shows how your inventory's prices moved meanwhile). Under $1 is paid without the popup.

## Admin panel

Log in as the account named exactly `admin` (same case) and an **Admin** link appears in the sidebar. Everyone else gets a 404 from `/api/admin`.

- **Rig**: a global slider plus per-game overrides for how much the house tilts each game, on top of its normal odds. 0% (the default) is fair: the odds shown are the real ones. The panel lists what each game pays back at the current setting. How it works per game:
  - cases: re-rolls that share of Classified-or-better drops;
  - upgrader: the real chance is (1 − rig) × the chance shown;
  - plinko: bounces lean rig/2 toward the low-paying middle;
  - flashbang: crash odds become (0.99 − rig) / x;
  - roulette: that share of spins land on the number paying the table least;
  - b-hop: each jump's real safety is (1 − rig) × what's shown;
  - defuse: that share of safe picks get a bomb moved under them;
  - coinflip against a bot: the bot wins 50% + rig/2.

  Player-vs-player games (battles, jackpot, coinflip between players) have no house and aren't affected.
- **Site**: maintenance mode (no new bets or openings; cash-outs, selling and trading still work; turning it on hands back every bet on a flashbang, roulette, bot race, bomb plant, blackjack or jackpot round that hadn't started yet, so nothing placed just before still plays), a site-wide announcement banner, popping the current flashbang round, and **Refresh everyone's page**: after updating the server, every open page reloads within a few seconds and gets the new version.
- **Economy**: players online, total balances and item value, and per game the rounds played, amount wagered and paid out, the house's result and the actual payback; Steam price-collector status.
- **Rig the next round**: set where the next flashbang pops, the next roulette number, the next bot race winner, how the next bomb plant ends, and who wins the current jackpot pot (someone already in it). Each is used once and overrides the rig setting; nobody is told. Per player (the **Rig** button in the player list): make a specific item their next case drop (whatever case they open), and make their next upgrade win or lose.
- **Events**: timed events everyone sees as a banner with a countdown (and that the chat announces): **Cashback** (a percentage of every losing bet's loss paid straight back), **Click frenzy** (the clicker pays a multiple) and **Mission bonus** (daily mission rewards multiplied), each for 1 minute to 24 hours and endable early. One-off events: **House rain** (an amount split among everyone online, with the full rain effect, paid by the house rather than your balance) and **Case drop** (everyone online gets one free opening of a case you pick).
- **Chat & rewards**: leaderboard prizes per place for days and weeks, the smallest /rain allowed, and clearing the chat. Single messages are deleted with the bin icon that shows on them in the chat (admin only).
- **Promo codes**: create codes that give balance, an item, or both, with an optional use limit and expiry; see how often each was used; delete them.
- **Players**: search, give or take money, give any item (pick wear / StatTrak), reset an account, mute in chat (for some minutes or for good), ban / unban (a ban logs them out at once).

## Run

```sh
npm install
npm run dev        # http://localhost:3000 (Vite + API on one port)

npm run build
npm start          # production: serves dist/ + API, PORT defaults to 3000
```

Behind an HTTP proxy on Node 22, prefix with `NODE_USE_ENV_PROXY=1` so `fetch` uses it.

Needs a host that runs Node (a VPS, Fly.io, Render, Railway…). Static hosting like GitHub Pages won't work anymore because the price schedule lives on the server.

Needs **Node 22.13 or newer** (it uses Node's built-in SQLite, so there's nothing extra to install).

## Accounts

- Everything is stored in `data/strafeclicker.db` (SQLite): users, inventories and login sessions. Back up that file to back up everyone's stuff.
- Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly cookie, valid for 30 days; only their hash is stored.
- Failed logins are limited to 15 per IP every 10 minutes (per IP, not per username, so nobody can lock someone else's account). Behind a reverse proxy or Cloudflare Tunnel, set `TRUST_PROXY=1` so the real client IP is used (it reads Cloudflare's `CF-Connecting-IP`, otherwise the last `X-Forwarded-For` entry).
- Everyone starts at $0 (`STARTING_BALANCE` in `server/game.mjs`).
- Anonymous accounts from older versions (`data/accounts.json`) are imported on first start. Signing up from the same browser carries that account's balance and items over.

## Run on ZimaOS (Docker + Cloudflare Tunnel)

On the Zima box (SSH or its terminal):

```sh
cd /DATA
git clone -b claude/inspiring-thompson-a4htcj https://github.com/ARandomEnderman/strafeclicker.git
cd strafeclicker
docker compose up -d --build
docker logs -f strafeclicker      # wait for "listening on http://localhost:3000", then Ctrl+C
```

No `git` on the box? Download the code instead:
`wget -O sc.tar.gz https://github.com/ARandomEnderman/strafeclicker/archive/refs/heads/claude/inspiring-thompson-a4htcj.tar.gz && tar xzf sc.tar.gz`

- Open `http://<zima-ip>:3000` on your network to check it works.
- In the Cloudflared app, point the public hostname at `http://<zima-ip>:3000`.
- Everything is stored in `/DATA/AppData/strafeclicker` (accounts database, compressed price history). Back up that folder.
- Update later with `git pull && docker compose up -d --build`. Data is kept.
- Port 3000 taken? Change the left side of `"3000:3000"` in `docker-compose.yml`, e.g. `"3100:3000"`.
- `TRUST_PROXY=1` is already set in the compose file. Don't port-forward the port on your router; the tunnel doesn't need it.

## How prices work

- **Steam Community Market** is the main source: the lowest current listing of each item (what a buyer pays, Steam's fee included). Steam has no bulk price API and its market search returns 10 items per request, so `server/steam.mjs` collects prices continuously, at most one request every `STEAM_INTERVAL_MS` (default 4000 ms):
  - two requests in three walk the whole market (~35,000 items) in name order, so every item is refreshed every few hours;
  - one in three looks up a "hot" item (anything someone owns, then cases and capsules), so those stay minutes fresh.
  - If Steam rate-limits (HTTP 429) it pauses for 1 minute (doubling up to 15) and slows its pace by 1.5x; after 100 requests in a row without a 429 it speeds up again by 10%, never faster than `STEAM_INTERVAL_MS`. So it settles at whatever Steam allows your IP. What it has collected (and the pace it settled on) is saved to `data/steam-prices.json`, so a restart picks up where it left off.
- **Skinport** (lowest listing) fills what Steam can't: Doppler and Gamma Doppler phases (Steam lists all phases of a knife under one name) and items Steam hasn't reached yet. Skinport allows 8 requests per 5 minutes and refreshes about every 5 minutes; the server uses 6.
- `server/index.mjs` ticks at every wall-clock minute and builds the price list from whatever both sources have at that moment, so each tick carries the Steam prices collected during the last minute. The countdown resets every minute.
- When the server first switches to Steam, prices move from Skinport's to Steam's as the sweep reaches each item (Steam is usually higher), so expect one bigger jump in the graphs and in the price-change messages.
- Price history is stored brotli-compressed in `data/history.br` (about 10× smaller than plain JSON), with changes since the last hourly repack in `data/history.ndjson`. Set `DATA_DIR` to move it. Points older than 48 hours are thinned to one per hour.
- On first start the history is backfilled with Skinport's 90/30/7-day and 24-hour sale medians, so graphs aren't empty. They're drawn dashed and left out of the change/high/low stats, since sale medians aren't the same measure as the live listing price.
- Browsers subscribe to `/api/events` (Server-Sent Events). On each tick they fetch only the prices that changed (`/api/prices?since=<version>`).

| Endpoint | |
| --- | --- |
| `GET /api/catalog` | Cases and items (no prices) |
| `GET /api/prices?since=v` | Flat price map, or just the changes since version `v` |
| `GET /api/status` | Last / next update time, version, last error |
| `GET /api/events` | SSE stream: `status`, `wins` (recent list on connect), `win`, `fb` (flashbang round), `battles`, and for your own session `account` and `friends` |
| `GET /api/history/:itemId` | Price history for every variant of an item |
| `POST /api/register` `{username, password}` | Create an account and log in |
| `POST /api/login` `{username, password}` | Log in |
| `POST /api/logout` | Log out |
| `GET /api/me` | Your account (401 when logged out) |
| `POST /api/click` `{clicks, times}` | Credit clicks; `times` are the click timestamps (ms) |
| `POST /api/open` `{caseId, count}` | Open 1–5 of a case, up to your multi-open level |
| `POST /api/sell` `{uids}` | Sell items at the current price |
| `POST /api/upgrade` `{uids, target}` | Stake items on a target variant |
| `POST /api/perk` `{perk}` | Buy the next level of `multiOpen`, `clickPower`, `offlineIncome`, `battleRounds` or `maxBet` |
| `POST /api/plinko` `{bet, rows, risk}` | Drop a plinko ball; returns its path and payout |
| `POST /api/flashbang` `{action: "bet", bet, auto?}` / `{action: "cancel"}` / `{action: "cashout"}` | Flashbang bets; round state comes over SSE as `fb` events |
| `POST /api/bhop` `{action: "start", bet, difficulty}` / `jump` / `cashout` / `state` | B-hop runs |
| `POST /api/battle` `{action: "create", cases, size, visibility}` / `join` `{id}` or `{code}` / `bots` / `cancel` | Case battles; the list (filtered per user) comes over SSE as `battles` events |
| `POST /api/friends` `{action: "list" \| "request" \| "accept" \| "remove", username}` | Friends and requests |
| `POST /api/claim` `{id?}` | Collect an unlocked achievement's reward (all of them without `id`) |
| `POST /api/trade` `{action: "list" \| "inventory" \| "offer" \| "accept" \| "decline" \| "cancel", ...}` | Trade offers with friends (`inventory` shows a friend's items) |
| `POST /api/profile` `{username}` / `{action: "rename", name}` | A player's profile (more for friends), or set your display name |
| `POST /api/defuse` `{action: "start", bet, bombs}` / `reveal` `{tile}` / `cashout` / `state` | Defuse rounds |
| `POST /api/roulette` `{color, bet}` | Bet on `t`, `ct` or `green` this round; round state comes over SSE as `roulette` events |
| `POST /api/coinflip` `{action: "create", uids, side, visibility}` / `join` `{id, uids}` or `{code}` / `bot` / `cancel` | Coinflips; the list comes over SSE as `flips` events |
| `POST /api/jackpot` `{uids}` / `{action: "withdraw"}` | Deposit items into the pot, or take them back before anyone else joins; round state comes over SSE as `jackpot` events |
| `POST /api/admin` `{action, ...}` | Admin panel (account `admin` only) |
| `POST /api/chat` `{text}` | Send a chat message, `/rain <amount>` or `/pay <user> <amount>`; the chat comes over SSE as `chat` (history) and `chatmsg` events |
| `POST /api/clans` `{action: "overview"}` / `view` `{id}` / `create` `{name, tag, open}` / `join` `{id}` / `accept` / `decline` / `kick` `{username}` / `leave` / `settings` `{open}` | Clans; member tags come over SSE as `tags` events |
| `POST /api/missions` `{id?}` | Claim a finished daily mission (all of them without `id`) |
| `POST /api/leaderboard` | Today's, this week's and the richest leaderboards |
| `POST /api/promo` `{code}` | Redeem a promo code |
| `POST /api/spin` | The daily spin |
| `POST /api/keno` `{bet, picks}` | A keno round (picks are tile numbers 0–48) |
| `POST /api/defuse` `{action: "auto", bet, bombs, tiles}` | One whole Defuse round revealing `tiles` in order (auto mode) |
| `POST /api/towers` `{action: "start", bet, difficulty}` / `pick` `{door}` / `cashout` / `state` | Towers |
| `POST /api/race` `{bot, bet}` | Bet on a bot (0–4) this round; round state comes over SSE as `race` events |
| `POST /api/bracket` `{action: "create", size, fee, visibility, stages: [{game, caseId?}]}` / `join` `{id}` or `{code}` / `bots` / `leave` / `pick` `{id, hand}` | Bracket tournaments; the list comes over SSE as `brackets` events |
| `POST /api/rps` `{action: "create", bet, visibility}` / `join` `{id}` or `{code}` / `bot` / `cancel` / `pick` `{id, hand}` | Rock paper scissors duels; the list comes over SSE as `rps` events |
| `POST /api/bombplant` `{pick, bet}` | Bet on `A`, `B`, `boom`, `defuse` or a combination like `A-boom`; round state comes over SSE as `bombplant` events |
| `POST /api/poker` `{action: "deal", bet}` / `draw` `{hold: [5 booleans]}` / `state` | Video poker |
| `POST /api/blackjack` `{action: "bet", bet}` / `hit` / `stand` / `double` | Blackjack; your table comes over SSE as `bj` events (the hole card stays hidden until the dealer plays) |
| `POST /api/reset` | Wipe your balance, items and upgrades (keeps the login) |

POST bodies must be `application/json`, which also stops other sites from posting forms to it.

`server/snapshot.json.gz` is a committed set of contents and prices. The server falls back to it if GitHub is unreachable and starts from its prices until the first tick. Regenerate it with `npm run data`.

## Plugging in a skin texture generator

All skin pictures go through `src/skin-renderer.ts`. By default it shows the official inventory icon. To use a generator:

```ts
import { setSkinRenderer } from "./skin-renderer";

setSkinRenderer(({ item, phase, float, seed, stattrak, size }) => {
  const canvas = document.createElement("canvas");
  // item.pattern / item.paintIndex identify the finish; float and seed are set for actual drops
  return canvas;
});
```

The returned element is placed in a fixed 4:3 box and should fill it.

## Layout

| Path | What |
| --- | --- |
| `server/index.mjs` | HTTP server, price ticks, SSE, account cookies |
| `server/game.mjs` | Every money action: open, sell, click, upgrade, perks |
| `server/auth.mjs` | Sign-up, login, sessions |
| `server/db.mjs` | SQLite schema |
| `server/feed.mjs` | Live big-wins feed |
| `server/games/` | Plinko, flashbang, roulette, coinflip, jackpot, b-hop, defuse, case battles |
| `server/friends.mjs` | Friend requests and lists |
| `server/trades.mjs` | Trade offers |
| `server/profiles.mjs` | Player profiles |
| `server/admin.mjs`, `server/settings.mjs` | Admin panel and its settings (rig, maintenance, announcement, prizes) |
| `server/chat.mjs` | Chat, /rain and /pay |
| `server/missions.mjs`, `server/leaderboard.mjs`, `server/promos.mjs` | Daily missions, leaderboards, promo codes |
| `server/steam.mjs` | Steam Market price collector |
| `shared/achievements.js` | Achievement list, goals and rewards |
| `shared/game.js` | Odds, float generation, upgrade chance, perk table (server rolls with it, browser displays it) |
| `server/data.mjs` | Case contents + Skinport prices |
| `server/history.mjs` | Price history log |
| `scripts/build-data.mjs` | Regenerates `server/snapshot.json.gz` |
| `src/odds.ts` | Re-exports the shared rules plus rarity labels |
| `src/catalog.ts` | Pricing and expected value |
| `src/live.ts` | Listens for server price updates |
| `src/state.ts` | Mirrors the server account, sends actions |
| `src/skin-renderer.ts` | Skin picture plug point |
| `src/ui/` | Pages (cases, clicker, upgrader, upgrade tree, inventory), sidebar feed, countdown, popup, price chart |

Icons are from [Lucide](https://lucide.dev) (ISC licence); `src/ui/icons.ts` lists the ones used.
