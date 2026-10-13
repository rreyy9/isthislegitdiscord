import { memo, type ComponentProps } from 'react';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../theme';

/**
 * Every icon in the app, from one font.
 *
 * These used to be emoji and Unicode symbols -- ☰, 🔍, 📌, ⚙ -- and that was
 * the single biggest thing making the app look unfinished: each phone maker
 * draws emoji differently, several of them are full-colour pictures in a dark
 * interface, and a symbol like ▤ falls back to whatever font happens to carry
 * it. A glyph font draws the same shape, in the colour asked for, everywhere.
 *
 * `@expo/vector-icons` and not an SVG library, because of the rule in
 * package.json: no new native module without a reason it cannot be done
 * without. This one is JavaScript over `expo-font`, which `expo` already links,
 * so it adds a font file and nothing to the Gradle build. Imported from its
 * own path rather than the package root so that only this one font is
 * bundled, not all nineteen.
 *
 * Material Community rather than Ionicons because it is the one set with all
 * of a thumbtack, a pound sign and a speaker, which are the three a chat
 * client cannot do without.
 */

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

export const Icon = memo(function Icon({
  name,
  size = 20,
  color = theme.textMuted,
}: IconProps) {
  return (
    <MaterialCommunityIcons
      name={name}
      size={size}
      color={color}
      // Decorative wherever it is used: the control around it carries the
      // label, and a screen reader announcing "image" before every button
      // would be noise.
      accessible={false}
      importantForAccessibility="no"
    />
  );
});

/** Loaded by the root layout before anything draws, so no icon flashes blank. */
export const ICON_FONT = MaterialCommunityIcons.font;
