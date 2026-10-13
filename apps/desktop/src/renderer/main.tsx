import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/nunito';
import './styles.css';
import { initTheme } from './theme';

// Before the first render, so the first frame is drawn in the chosen theme
// rather than in the stylesheet's default and then repainted.
initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
