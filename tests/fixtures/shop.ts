// A small multi-page shop for browser tests (no network). Variant 2 is a "redesign": a cookie
// page appears, the add button is renamed, and the final "Finish" button becomes "Confirm"
// (no risky word in it, so only the recipe's inherited risk can catch it).
import { randomUUID } from "node:crypto";
import http from "node:http";

export const SHOP_USER = "shopper";
export const SHOP_PASSWORD = "pw-Fixture-7392!";
const PRODUCTS: Record<string, { name: string; price: number }> = {
  backpack: { name: "Trail Backpack", price: 29.99 },
  "bike-light": { name: "Bike Light", price: 9.99 },
  onesie: { name: "Baby Onesie", price: 7.99 },
};

export interface Order {
  items: string[];
  first: string;
  last: string;
  zip: string;
  total: string;
}

export interface Shop {
  url: string;
  origin: string;
  orders: Order[];
  variant: 1 | 2;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}<footer><a href="https://example.com/" data-test="social">Follow us</a></footer></body></html>`;

export async function startShop(): Promise<Shop> {
  const sessions = new Map<string, { cart: string[]; info?: { first: string; last: string; zip: string }; consent?: boolean }>();
  const shop = { orders: [] as Order[], variant: 1 as 1 | 2 } as Shop;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const sid = (req.headers.cookie ?? "").match(/sid=([\w-]+)/)?.[1];
    const s = sid ? sessions.get(sid) : undefined;
    const body = await new Promise<URLSearchParams>((r) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => r(new URLSearchParams(b)));
    });
    const html = (t: string, b: string) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(page(t, b));
    };
    const redirect = (to: string, cookie?: string) => {
      res.statusCode = 303;
      if (cookie) res.setHeader("set-cookie", cookie);
      res.setHeader("location", to);
      res.end();
    };
    const v2 = shop.variant === 2;

    if (u.pathname === "/" || u.pathname === "/login") {
      if (req.method === "POST") {
        if (body.get("user") === SHOP_USER && body.get("pw") === SHOP_PASSWORD) {
          const id = randomUUID();
          sessions.set(id, { cart: [] });
          return redirect("/inventory", `sid=${id}; Path=/; HttpOnly`);
        }
        return html("Login", `<h1>Login</h1><p class="error">Wrong username or password</p>`);
      }
      return html("Login", `<h1>Login</h1><form method="post" action="/login">
        <input name="user" placeholder="Username" autocomplete="username">
        <input name="pw" type="password" placeholder="Password">
        <button id="login-button" type="submit">Sign in</button></form>`);
    }
    if (!s) return redirect("/login");
    if (v2 && !s.consent) {
      if (u.pathname === "/consent" && req.method === "POST") {
        s.consent = true;
        return redirect("/inventory");
      }
      return html("Cookies", `<h1>We use cookies</h1><form method="post" action="/consent"><button data-test="accept-cookies">Accept cookies</button></form>`);
    }
    if (u.pathname === "/inventory") {
      const items = Object.entries(PRODUCTS)
        .map(([slug, p], n) => `<li><a class="item-title" href="/p/${slug}" data-test="item-${n}-title-link">${p.name}</a> $${p.price}
          <form method="post" action="/cart/add" style="display:inline"><input type="hidden" name="item" value="${slug}">
          <button data-test="${v2 ? "add-to-basket" : "add-to-cart"}-${slug}">${v2 ? "Add to basket" : "Add to cart"}</button></form></li>`)
        .join("");
      return html("Products", `<h1>Products</h1><a href="/cart" data-test="cart-link">Cart (${s.cart.length})</a><ul>${items}</ul>`);
    }
    const pm = u.pathname.match(/^\/p\/([a-z-]+)$/);
    if (pm && PRODUCTS[pm[1]]) {
      const p = PRODUCTS[pm[1]];
      return html(p.name, `<h1>${p.name}</h1><p>$${p.price}</p><form method="post" action="/cart/add"><input type="hidden" name="item" value="${pm[1]}"><button data-test="add-to-cart">Add to cart</button></form><a href="/cart" data-test="cart-link">Cart (${s.cart.length})</a>`);
    }
    if (u.pathname === "/cart/add" && req.method === "POST") {
      const item = body.get("item") ?? "";
      if (PRODUCTS[item]) s.cart.push(item);
      return redirect("/inventory");
    }
    if (u.pathname === "/cart") {
      return html("Cart", `<h1>Your cart</h1><ul>${s.cart.map((i) => `<li class="cart-item">${PRODUCTS[i].name} <span class="price">$${PRODUCTS[i].price}</span></li>`).join("")}</ul>
        <form method="get" action="/checkout"><button data-test="checkout">Checkout</button></form>`);
    }
    if (u.pathname === "/checkout") {
      if (req.method === "POST") {
        s.info = { first: body.get("firstName") ?? "", last: body.get("lastName") ?? "", zip: body.get("postalCode") ?? "" };
        return redirect("/overview");
      }
      return html("Checkout", `<h1>Your information</h1><form method="post" action="/checkout">
        <input name="firstName" placeholder="First name"><input name="lastName" placeholder="Last name">
        <input name="postalCode" placeholder="Zip code"><input type="submit" data-test="continue" value="Continue"></form>`);
    }
    if (u.pathname === "/overview") {
      const total = s.cart.reduce((t, i) => t + PRODUCTS[i].price, 0).toFixed(2);
      return html("Overview", `<h1>Overview</h1><ul>${s.cart.map((i) => `<li class="cart-item">${PRODUCTS[i].name}</li>`).join("")}</ul>
        <p class="summary-total">Total: $${total}</p>
        <form method="post" action="/finish"><button data-test="${v2 ? "confirm" : "finish"}">${v2 ? "Confirm" : "Finish"}</button></form>`);
    }
    if (u.pathname === "/finish" && req.method === "POST") {
      const total = s.cart.reduce((t, i) => t + PRODUCTS[i].price, 0).toFixed(2);
      shop.orders.push({ items: s.cart.map((i) => PRODUCTS[i].name), first: s.info?.first ?? "", last: s.info?.last ?? "", zip: s.info?.zip ?? "", total });
      s.cart = [];
      return html("Done", `<h1 class="complete-header">Thank you for your order!</h1>`);
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  shop.origin = `http://127.0.0.1:${port}`;
  shop.url = `${shop.origin}/login`;
  shop.close = () => new Promise((r) => server.close(() => r()));
  return shop;
}
