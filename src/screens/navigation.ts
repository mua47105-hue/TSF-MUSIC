import type { Collection, Playlist, Track } from '../types';
import type { NavigatorScreenParams } from '@react-navigation/native';

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Player: undefined;
  Collection: { collection: Collection; tracks?: Track[] };
  Playlist: { playlistId: string };
  Stats: undefined;
  Taste: undefined;
  AI: undefined;
  Premium: undefined;
};

export type TabParamList = {
  Home: undefined;
  Search: undefined;
  Library: undefined;
  Wire: undefined;
};
