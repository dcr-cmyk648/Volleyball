import { calculateBayesianScoreboard } from './bayesian-ratings.js';
import { calculateOverallDynamicScoreboard } from './overall-dynamic-ratings.js';

self.addEventListener('message', event => {
  const { type, players, games, priorGames, includeLeagueRatings, dynamicOverall } = event.data || {};
  if (type !== 'calculate') return;

  try {
    const calculate = dynamicOverall ? calculateOverallDynamicScoreboard : calculateBayesianScoreboard;
    const snapshot = calculate({
      players,
      games,
      ...(dynamicOverall ? {} : { includeLeagueRatings }),
      onProgress: message => self.postMessage({
        ...message,
        percent: Math.min(88, Math.floor((Number(message.percent) || 0) * 0.88)),
      }),
    });
    if (Array.isArray(priorGames)) {
      self.postMessage({
        type: 'progress',
        stage: 'trend',
        percent: 90,
        message: 'Estimating rank movement since last session',
        diagnostics: {},
      });
      const priorSnapshot = calculate({
        players,
        games: priorGames,
        ...(dynamicOverall ? {} : { includeLeagueRatings }),
      });
      snapshot.priorRatings = priorSnapshot.ratings;
      snapshot.priorGamesConsidered = priorSnapshot.gamesConsidered;
      self.postMessage({
        type: 'progress',
        stage: 'trend',
        percent: 94,
        message: 'Preparing Bayesian rank movement',
        diagnostics: {},
      });
    }
    self.postMessage({ type: 'complete', snapshot });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Bayesian calculation failed.',
    });
  }
});
