import type { ScopedThreadRef } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { conversation, useConversation } from "./conversation";
import { openConversation } from "./startConversation";

/**
 * Above the composer while a conversation with this thread runs: the way back in and out. Else a
 * notice a conversation left about this thread (a message that wasn't sent) stays until dismissed.
 */
export function ConversationBar(props: { readonly threadRef: ScopedThreadRef | null }) {
  const view = useConversation();
  const ref = props.threadRef;
  if (ref === null) return null;
  const same = (other: ScopedThreadRef | null | undefined) =>
    other?.environmentId === ref.environmentId && other.threadId === ref.threadId;
  if (!same(view.ref) || view.state.phase.kind === "off") {
    return view.notice && same(view.notice.ref) ? (
      <View className="px-4 pb-2">
        <Notice
          message={view.notice.text}
          onDismiss={() => conversation.dismissNotice()}
          dismissLabel="Dismiss"
        />
      </View>
    ) : null;
  }
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="headphones" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Conversation running
      </Text>
      <Button label="Open" tone="text" onPress={() => openConversation(ref)} />
      <Button label="End" tone="text" onPress={() => void conversation.stop()} />
    </View>
  );
}
