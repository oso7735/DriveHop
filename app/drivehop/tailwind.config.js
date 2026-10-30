export default {
  safelist: [
    'bg-oceanNight', 'bg-oceanPanel', 'bg-oceanRaised', 'bg-oceanEdge', 'bg-oceanMint', 'bg-oceanViolet',
    'text-oceanNight', 'text-oceanMint', 'text-oceanViolet', 'text-oceanMuted', 'border-oceanEdge', 'border-oceanMint', 'border-oceanViolet',
    'focused:bg-oceanRaised', 'focused:border-oceanMint', 'focused:border-oceanViolet',
    'bg-emberNight', 'bg-emberPanel', 'bg-emberRaised', 'bg-emberEdge', 'bg-emberMint', 'bg-emberViolet',
    'text-emberNight', 'text-emberMint', 'text-emberViolet', 'text-emberMuted', 'border-emberEdge', 'border-emberMint', 'border-emberViolet',
    'focused:bg-emberRaised', 'focused:border-emberMint', 'focused:border-emberViolet',
    'bg-amethystNight', 'bg-amethystPanel', 'bg-amethystRaised', 'bg-amethystEdge', 'bg-amethystMint', 'bg-amethystViolet',
    'text-amethystNight', 'text-amethystMint', 'text-amethystViolet', 'text-amethystMuted', 'border-amethystEdge', 'border-amethystMint', 'border-amethystViolet',
    'focused:bg-amethystRaised', 'focused:border-amethystMint', 'focused:border-amethystViolet',
  ],
  theme: {
    extend: {
      colors: {
        night: '#090b12',
        panel: '#111622',
        raised: '#171e2d',
        edge: '#293247',
        mint: '#67e8d5',
        violet: '#a78bfa',
        danger: '#fb7185',
        muted: '#98a2b8',
        oceanNight: '#06131d', oceanPanel: '#0d2433', oceanRaised: '#143447', oceanEdge: '#28536a', oceanMint: '#38bdf8', oceanViolet: '#22d3ee', oceanMuted: '#94a3b8',
        emberNight: '#140b0a', emberPanel: '#21110f', emberRaised: '#321b16', emberEdge: '#5b3025', emberMint: '#fb923c', emberViolet: '#fbbf24', emberMuted: '#b8a39c',
        amethystNight: '#0e0918', amethystPanel: '#191128', amethystRaised: '#261a3a', amethystEdge: '#493566', amethystMint: '#d8b4fe', amethystViolet: '#f472b6', amethystMuted: '#aaa0bd',
      },
      fontFamily: {
        inter: './assets/Inter-Regular.ttf',
        semi: './assets/Inter-SemiBold.ttf',
        heavy: './assets/Inter-Bold.ttf',
      },
    },
  },
};
