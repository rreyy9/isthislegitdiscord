import type { Ref } from 'react';

/**
 * The strip across the top of the main window, where the system title bar was.
 *
 * Drawn on every screen, not only in the chat: with the system frame gone this
 * is the only thing the window can be dragged by, and a login screen that
 * cannot be moved is a window stuck wherever it opened.
 *
 * It owns the frame and nothing else. What goes in the middle -- the search
 * box and the voice pill -- belongs to Chat, which renders into `slotRef`
 * through a portal, because that is where the state they read lives. Lifting
 * all of it up here to draw two controls would drag the whole chat closure
 * with it.
 *
 * The right-hand end is left clear for the caption buttons, which Windows
 * draws over the page; styles.css reads their width from `env(titlebar-area-*)`.
 */
export function TitleBar({ slotRef }: { slotRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="titlebar">
      <div className="tb-brand">
        <img className="tb-logo" src="./icon.png" alt="" aria-hidden="true" />
        isthislegit
      </div>
      <div className="tb-slot" ref={slotRef} />
    </div>
  );
}
