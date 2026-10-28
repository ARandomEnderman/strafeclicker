// What each game is called on screen, by the id the server uses in stats.

export const GAME_NAMES: Record<string, string> = {
  cases: "Cases",
  upgrade: "Upgrader",
  plinko: "Plinko",
  flashbang: "Flashbang",
  roulette: "Roulette",
  bhop: "B-hop",
  defuse: "Defuse",
  towers: "Towers",
  keno: "Keno",
  race: "Bot race",
  blackjack: "Blackjack",
  poker: "Video poker",
  bombplant: "Bomb plant",
  rps: "Rock paper scissors",
  coinflip: "Coinflip",
  jackpot: "Jackpot",
  battle: "Case battle",
  bracket: "Bracket",
};

export const gameName = (id: string) => GAME_NAMES[id] ?? id;
