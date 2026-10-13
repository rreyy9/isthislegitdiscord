import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { channelIcon, personName } from '../format';
import { useSession } from '../session';
import { radius, spacing, TAP_TARGET, theme } from '../theme';
import type { Channel, Guild, PublicUser } from '../types';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * The channel list, as both the home screen and the drawer draw it.
 *
 * One component rather than two copies. The two lists used to be written out
 * separately and had already started to drift -- and a channel that looks
 * unread in one and read in the other is the kind of disagreement that makes
 * somebody stop trusting both.
 *
 * Text and voice are separate sections, the same split the desktop sidebar
 * makes. They used to be one list in the server's order, with voice channels
 * dimmed and labelled "voice"; with occupants drawn under them, voice channels
 * are now something to look at rather than something to skip past, and
 * interleaving them with text channels would push the conversations apart.
 */

export interface ChannelSection {
  key: string;
  title: string;
  data: Channel[];
}

/**
 * Sections for a `SectionList`: text then voice, per guild, each in the
 * server's `position` order -- the ordering the server decides and the one the
 * desktop sidebar draws.
 *
 * With one guild, which is what this application almost always has, the guild
 * name is in the header already and the sections just say what kind of channel
 * they hold. With several, each section is named for its guild as well.
 */
export function channelSections(guilds: Guild[]): ChannelSection[] {
  const several = guilds.length > 1;
  return guilds.flatMap((guild) => {
    const sorted = [...guild.channels].sort((a, b) => a.position - b.position);
    const texts = sorted.filter((c) => c.kind === 'TEXT');
    const voices = sorted.filter((c) => c.kind === 'VOICE');
    const out: ChannelSection[] = [];
    if (texts.length > 0) {
      out.push({
        key: `${guild.id}:text`,
        title: several ? guild.name : 'Text channels',
        data: texts,
      });
    }
    if (voices.length > 0) {
      out.push({
        key: `${guild.id}:voice`,
        title: several ? `${guild.name} · voice` : 'Voice channels',
        data: voices,
      });
    }
    return out;
  });
}

export function useChannelSections(): ChannelSection[] {
  const { guilds } = useSession();
  return useMemo(() => channelSections(guilds), [guilds]);
}

export function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

/* ----------------------------------------------------------------- row */

export interface ChannelRowProps {
  channel: Channel;
  /** The channel on screen right now. Drawn lit, with a tall marker. */
  active?: boolean;
  /**
   * How to show who is in a voice channel. `list` puts each person on a line
   * of their own under the channel, which is what the home screen has room
   * for; `stack` is a row of overlapping faces at the end of the line, for the
   * narrower drawer.
   */
  occupants: 'list' | 'stack';
  /** The panel the list is drawn on, so the rings around faces match it. */
  surface: string;
  onOpen: (channel: Channel) => void;
}

export const ChannelRow = memo(function ChannelRow({
  channel,
  active,
  occupants,
  surface,
  onOpen,
}: ChannelRowProps) {
  const { isUnread, mentionsIn, voiceByChannel, userFor } = useSession();

  const text = channel.kind === 'TEXT';
  const unread = text && !active && isUnread(channel.id);
  const tags = text ? mentionsIn(channel.id) : 0;
  const inside = text ? [] : (voiceByChannel[channel.id] ?? []);
  const people = inside
    .map((id) => userFor(id))
    .filter((u): u is PublicUser => u !== null);
  const occupied = inside.length > 0;

  const label =
    channel.name +
    (text ? '' : occupied ? `, voice channel, ${inside.length} in it` : ', voice channel, empty') +
    (tags ? `, ${tags} unread mentions` : unread ? ', unread' : '');

  return (
    <View>
      <Pressable
        onPress={() => onOpen(channel)}
        style={({ pressed }) => [
          styles.row,
          active && styles.rowActive,
          pressed && styles.rowPressed,
        ]}
        accessibilityRole="button"
        accessibilityState={{ selected: Boolean(active) }}
        accessibilityLabel={label}
      >
        {/* The marker in the margin. Short for unread, tall for the channel on
            screen -- the convention people already read in every chat client
            that has a sidebar, and legible at arm's length in a way that bold
            text alone is not. */}
        {(unread || active) && (
          <View style={[styles.marker, active ? styles.markerActive : styles.markerUnread]} />
        )}

        <Icon
          name={channelIcon(channel)}
          size={18}
          color={
            !text && occupied
              ? theme.online
              : unread || active
                ? theme.textMuted
                : theme.textFaint
          }
        />
        <Text
          style={[
            styles.name,
            (unread || active || occupied) && styles.nameLit,
            unread && styles.nameUnread,
          ]}
          numberOfLines={1}
        >
          {channel.name}
        </Text>

        {tags > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{tags > 99 ? '99+' : tags}</Text>
          </View>
        )}

        {!text && occupants === 'stack' && occupied && (
          <FaceStack people={people} extra={inside.length - people.length} ring={surface} />
        )}
        {!text && occupants === 'list' && occupied && (
          <Text style={styles.count}>{inside.length}</Text>
        )}
        {!text && channel.listenOnly && !occupied && (
          <Text style={styles.tag}>listen only</Text>
        )}
      </Pressable>

      {!text && occupants === 'list' && people.length > 0 && (
        <View style={styles.occupants}>
          {people.map((user) => (
            <Pressable
              key={user.id}
              onPress={() => onOpen(channel)}
              style={styles.occupant}
              accessibilityRole="button"
              accessibilityLabel={`${personName(user)}, in ${channel.name}`}
            >
              <Avatar
                userId={user.id}
                name={personName(user)}
                image={user.image}
                size={22}
              />
              <Text style={styles.occupantName} numberOfLines={1}>
                {personName(user)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
});

/** Up to three faces, overlapping, and a count for the rest. */
function FaceStack({
  people,
  extra,
  ring,
}: {
  people: PublicUser[];
  /** People in the call this client has no member row for. Counted, not drawn. */
  extra: number;
  ring: string;
}) {
  const shown = people.slice(0, 3);
  const more = people.length - shown.length + extra;
  return (
    <View style={styles.stack}>
      {shown.map((user, i) => (
        <View key={user.id} style={i > 0 && styles.stackOverlap}>
          <Avatar
            userId={user.id}
            name={personName(user)}
            image={user.image}
            size={20}
            ringed
            ringColor={ring}
          />
        </View>
      ))}
      {more > 0 && <Text style={styles.stackMore}>+{more}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.sm,
    marginHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  rowActive: { backgroundColor: theme.surfaceAlt },
  rowPressed: { backgroundColor: theme.surfaceAlt },

  marker: {
    position: 'absolute',
    left: -spacing.sm,
    width: 4,
    borderTopRightRadius: radius.pill,
    borderBottomRightRadius: radius.pill,
    backgroundColor: theme.text,
  },
  markerUnread: { height: 8 },
  markerActive: { height: 22 },

  name: { color: theme.textMuted, fontSize: 15, flex: 1 },
  nameLit: { color: theme.text },
  nameUnread: { fontWeight: '700' },

  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: theme.danger,
    alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  count: { color: theme.online, fontSize: 12, fontWeight: '600' },
  tag: {
    color: theme.textFaint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  occupants: {
    paddingLeft: spacing.sm + 18 + spacing.sm + spacing.sm,
    paddingRight: spacing.md,
    paddingBottom: spacing.xs,
  },
  occupant: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 30,
  },
  occupantName: { color: theme.textMuted, fontSize: 14, flexShrink: 1 },

  stack: { flexDirection: 'row', alignItems: 'center' },
  stackOverlap: { marginLeft: -8 },
  stackMore: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginLeft: spacing.xs,
  },
});
