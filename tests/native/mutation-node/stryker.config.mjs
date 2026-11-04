export default {
  mutate: ['src/add.js'],
  testRunner: 'command',
  commandRunner: { command: 'node --test test/*.test.js' },
  coverageAnalysis: 'off',
  reporters: ['json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  concurrency: 2,
  timeoutMS: 2000,
  timeoutFactor: 1.5,
  thresholds: { high: 100, low: 100, break: null },
  incremental: false,
  inPlace: false
};
