// Server-enforced app policy for customer keys. Coordinate tools (tap/swipe/type/key) can do
// anything a finger can, and the model declares its own risk, so approvals, allowlists, sending
// limits and STOP only hold if customers can't reach the apps that send, call, pay or change
// the phone. Those are blocked; texting goes through phone_send_message, which enforces all of
// them. The owner is not restricted. A key may instead list the only apps it may use.

import type { Principal } from "./keys.ts";

export const BLOCKED_APPS: Record<string, string> = {
  "com.apple.MobileSMS": "Messages: use phone_send_message / phone_read_messages / phone_wait_for_reply",
  "com.apple.mobilephone": "Phone (calls)",
  "com.apple.facetime": "FaceTime",
  "com.apple.InCallService": "calls in progress",
  "com.apple.mobilemail": "Mail",
  "com.apple.Passbook": "Wallet",
  "com.apple.Preferences": "Settings",
  "com.apple.AppStore": "App Store",
  "com.apple.Passwords": "Passwords",
  "com.apple.Bridge": "Watch",
  "com.apple.findmy": "Find My",
  // Android
  "com.google.android.apps.messaging": "Messages: use phone_send_message / phone_read_messages / phone_wait_for_reply",
  "com.samsung.android.messaging": "Messages: use phone_send_message / phone_read_messages / phone_wait_for_reply",
  "com.google.android.dialer": "Phone (calls)",
  "com.samsung.android.dialer": "Phone (calls)",
  "com.android.dialer": "Phone (calls)",
  "com.android.server.telecom": "calls in progress",
  "com.google.android.apps.tachyon": "Meet calls",
  "com.android.settings": "Settings",
  "com.google.android.apps.walletnfcrel": "Wallet",
  "com.samsung.android.spay": "Samsung Wallet",
  "com.android.vending": "Play Store",
  "com.google.android.apps.adm": "Find Hub",
};
/** Home screens: always allowed (iPhone SpringBoard, Android launchers). */
export const HOME_APPS = new Set([
  "com.apple.springboard", "com.google.android.apps.nexuslauncher", "com.android.launcher3", "com.sec.android.app.launcher",
  "com.miui.home", "net.oneplus.launcher", "com.motorola.launcher3",
]);
const ALWAYS_OK = HOME_APPS;

/** undefined = allowed; otherwise why not. Unknown foreground app fails closed for customers. */
export function appDenied(p: Principal, bundleId: string | undefined): string | undefined {
  if (p.kind === "owner") return undefined;
  if (!bundleId) return "couldn't tell which app is open";
  if (ALWAYS_OK.has(bundleId)) return undefined;
  if (p.allowApps) return p.allowApps.includes(bundleId) ? undefined : `${bundleId} isn't on this key's app list`;
  const why = BLOCKED_APPS[bundleId];
  return why ? `${why} is not available to agents on this key` : undefined;
}

/** Apps where a tap can publish or send something under the user's name. */
export const PUBLISH_APPS = new Set([
  "com.reddit.Reddit", "com.atebits.Tweetie2", "com.linkedin.LinkedIn", "com.facebook.Facebook", "com.burbn.instagram",
  "com.zhiliaoapp.musically", "com.burbn.barcelona", "net.whatsapp.WhatsApp", "ph.telegra.Telegraph", "com.hammerandchisel.discord",
  "com.tinyspeck.chatlyio", "com.google.Gmail", "com.microsoft.Office.Outlook",
  // Android
  "com.reddit.frontpage", "com.twitter.android", "com.linkedin.android", "com.facebook.katana", "com.instagram.android",
  "com.instagram.barcelona", "com.whatsapp", "org.telegram.messenger", "com.discord", "com.Slack", "com.google.android.gm",
  "com.microsoft.office.outlook", "com.ss.android.ugc.trill",
  // Browsers: the same sites on the web (Grok posted to Reddit through Safari).
  "com.apple.mobilesafari", "com.google.chrome.ios", "org.mozilla.ios.Firefox",
  "com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser",
]);
/** Labels of buttons that publish/send. Matched against the button under the tap point. */
export const PUBLISH_LABELS = "^(post|comment|reply|publish|tweet|repost|send|share post|post comment|post reply|reply all|send message|send sms|send mms)$";

const PUBLISH_WORDS = new Set(["post", "comment", "reply", "publish", "tweet", "repost", "send", "share"]);
/** Does OCR'd button text look like a publish/send action? e.g. "• Reply", "Post", "Send" (not "23 comments", not "Create Post"). */
export function looksLikePublish(lines: string[]): string | undefined {
  for (const raw of lines) {
    const words = raw.toLowerCase().replace(/[^a-z ]+/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 3 || words.includes("create") || words.includes("new")) continue;
    if (words.some((w) => PUBLISH_WORDS.has(w))) return raw;
  }
  return undefined;
}
/** Shopping, food and ride apps: a tap on their buy button spends the user's money (browsers too). */
export const SHOP_APPS = new Set([
  "com.amazon.Amazon", "com.walmart.electronics", "com.target.Target", "com.ebay.iphone", "com.contextlogic.Wish",
  "com.temu.temu", "com.zzkko.shein", "com.etsy.etsyforios", "com.bestbuy.BestBuy", "com.costco.mobile",
  "doordash.DoorDashConsumer", "com.ubercab.UberClient", "com.ubercab.UberEats", "com.grubhub.search", "com.instacart.client",
  "com.apple.mobilesafari", "com.google.chrome.ios", "org.mozilla.ios.Firefox",
  // Android
  "com.amazon.mShop.android.shopping", "com.walmart.android", "com.target.ui", "com.ebay.mobile", "com.einnovation.temu",
  "com.zzkko", "com.etsy.android", "com.bestbuy.android", "com.costco.app.android", "com.dd.doordash", "com.ubercab",
  "com.ubercab.eats", "com.grubhub.android", "com.instacart.client",
  "com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser",
]);
/** Labels of buttons that commit a purchase. Matched against the button under the tap point. */
export const PURCHASE_LABELS = "^(place your order|place order|buy now|pay now|pay|complete purchase|complete order|submit order|confirm order|confirm and pay|order now|place order and pay|request)$";
const PURCHASE_PHRASES = ["place your order", "place order", "buy now", "pay now", "complete purchase", "complete order", "submit order", "confirm order", "confirm and pay", "order now"];
/** Does OCR'd button text look like a buy button? e.g. "Place your order", "Buy Now", "Pay" (not "Proceed to checkout", not "Add to cart"). */
export function looksLikePurchase(lines: string[]): string | undefined {
  for (const raw of lines) {
    const t = raw.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!t || t.split(" ").length > 5) continue;
    if (t === "pay" || PURCHASE_PHRASES.some((p) => t === p || t.startsWith(p + " "))) return raw;
  }
  return undefined;
}
/** Native apps whose accessibility tree is small enough to query quickly (not browsers). */
export const isBrowser = (app: string) =>
  ["com.apple.mobilesafari", "com.google.chrome.ios", "org.mozilla.ios.Firefox", "com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser"].includes(app);
