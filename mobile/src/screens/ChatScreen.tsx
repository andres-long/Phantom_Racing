import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList, ChatMessage } from "../types";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import { colors, fonts } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Chat">;

// How often to re-fetch the thread while this screen is focused. The
// backend has no incremental/since param for messages -- see getMessages on
// the client -- so each tick just re-fetches the whole (short) thread,
// which is cheap enough at this volume.
const POLL_INTERVAL_MS = 3000;

// A 1:1 text thread with a specific nearby player, reached from the same
// selected-player card on Home that offers a race challenge. Deliberately
// simple: no read receipts, no typing indicator, no push notification --
// just a plain polled thread, matching how presence/race-challenge polling
// already work elsewhere in the app.
export default function ChatScreen({ route, navigation }: Props) {
  const { withDeviceId, withDisplayName } = route.params;
  const { user } = useUser();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api.getMessages(user.deviceId, withDeviceId);
      setMessages(res.messages);
    } catch {
      // Best-effort poll -- keep showing the last-known thread on a hiccup
      // rather than flashing an error over a background refresh.
    } finally {
      setLoading(false);
    }
  }, [user, withDeviceId]);

  useFocusEffect(
    useCallback(() => {
      fetchMessages();
      const t = setInterval(fetchMessages, POLL_INTERVAL_MS);
      return () => clearInterval(t);
    }, [fetchMessages])
  );

  useEffect(() => {
    if (messages.length === 0) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [messages.length]);

  const onSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !user || sending) return;
    setSending(true);
    setText("");
    try {
      await api.sendMessage(user.deviceId, withDeviceId, trimmed);
      await fetchMessages();
    } catch (e: any) {
      Alert.alert("Message not sent", e.message || "Unknown error");
      setText(trimmed);
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top}
    >
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.cyan} />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>Say hi to {withDisplayName} -- nearby racers can chat here.</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={[styles.bubbleRow, item.mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
              <View style={[styles.bubble, item.mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                <Text style={styles.bubbleText}>{item.text}</Text>
              </View>
            </View>
          )}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />
      )}

      <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TextInput
          style={styles.input}
          placeholder={`Message ${withDisplayName}...`}
          placeholderTextColor={colors.textMuted}
          value={text}
          onChangeText={setText}
          maxLength={500}
          multiline
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={onSend}
        />
        <Pressable
          style={[styles.sendButton, (!text.trim() || sending) && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={!text.trim() || sending}
        >
          <Text style={styles.sendButtonText}>SEND</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center", lineHeight: 20 },
  listContent: { padding: 16, paddingBottom: 8 },
  bubbleRow: { flexDirection: "row", marginBottom: 10 },
  bubbleRowMine: { justifyContent: "flex-end" },
  bubbleRowTheirs: { justifyContent: "flex-start" },
  bubble: { maxWidth: "78%", borderRadius: 12, paddingVertical: 9, paddingHorizontal: 13 },
  bubbleMine: { backgroundColor: colors.cyanDim, borderWidth: 1, borderColor: colors.panelBorderStrong },
  bubbleTheirs: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.panelBorder },
  bubbleText: { color: colors.textPrimary, fontSize: 15, lineHeight: 20 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.panelBorder,
    backgroundColor: colors.bgElevated,
  },
  input: {
    flex: 1,
    backgroundColor: colors.panel,
    color: colors.textPrimary,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.racePrimary,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sendButtonDisabled: { opacity: 0.4 },
  sendButtonText: { color: "#05070c", fontFamily: fonts.heading, fontSize: 12, letterSpacing: 0.5 },
});
