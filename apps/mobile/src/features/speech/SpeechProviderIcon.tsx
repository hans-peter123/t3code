import { speechProviderSite, type SpeechProviderConfig } from "@t3tools/client-runtime/speech";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

/** The provider's favicon, or a server symbol while it loads, fails, or the host is private. */
export function SpeechProviderIcon(props: { readonly provider: SpeechProviderConfig }) {
  const source = faviconUrlForOrigin(speechProviderSite(props.provider), 64);
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const usable = source !== null && failed !== source;
  return (
    <View className="size-6 items-center justify-center overflow-hidden rounded-md">
      {shown !== source || !usable ? (
        <SymbolView
          name="server.rack"
          size={20}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
      ) : null}
      {usable ? (
        <Image
          source={source}
          cachePolicy="memory-disk"
          contentFit="contain"
          style={[StyleSheet.absoluteFill, { opacity: shown === source ? 1 : 0 }]}
          onLoad={() => setShown(source)}
          onError={() => setFailed(source)}
        />
      ) : null}
    </View>
  );
}
