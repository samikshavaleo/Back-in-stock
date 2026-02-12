import { authenticate, shopify } from "../shopify.server";

/**
 * 🔐 Fetch CleverTap credentials for THIS store
 */
async function getCleverTapConfig(admin) {
  const res = await admin.query({
    data: `
      query {
        shop {
          accountId: metafield(namespace: "clevertap", key: "account_id") {
            value
          }
          passcode: metafield(namespace: "clevertap", key: "passcode") {
            value
          }
          region: metafield(namespace: "clevertap", key: "region") {
            value
          }
        }
      }
    `,
  });

  const json = res.body;

  return {
    accountId: json?.data?.shop?.accountId?.value,
    passcode: json?.data?.shop?.passcode?.value,
    region: json?.data?.shop?.region?.value,
  };
}

/**
 * 📤 Send Back In Stock event to CleverTap
 */
async function sendCleverTapBackInStockEvent({
  region,
  accountId,
  passcode,
  email,
  productId,
  variantId,
  productTitle,
  productUrl,
}) {
  const payload = {
    d: [
      {
        identity: email,
        type: "event",
        evtName: "Back In Stock",
        evtData: {
          product_id: productId,
          variant_id: variantId,
          product_title: productTitle,
          product_url: productUrl,
        },
        profileData: {
          Email: email,
        },
      },
    ],
  };

  const endpoint = `https://${region}.api.clevertap.com/1/upload`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-CleverTap-Account-Id": accountId,
      "X-CleverTap-Passcode": passcode,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CleverTap API error: ${err}`);
  }

  console.log("✅ CleverTap event sent →", email);
}

/**
 * 🚀 Inventory Webhook Handler
 */
export const action = async ({ request }) => {
  try {
    // 1️⃣ Authenticate webhook
    const { payload, shop } = await authenticate.webhook(request);

    console.log("📦 INVENTORY WEBHOOK HIT", {
      shop,
      inventory_item_id: payload.inventory_item_id,
      available: payload.available,
    });

    if (!payload.available || payload.available <= 0) {
      console.log("⏭️ Inventory still out of stock");
      return new Response("OK", { status: 200 });
    }

    console.log("✅ Stock is now available");

    // 2️⃣ Load stored session from Prisma
    const session = await shopify.sessionStorage.loadSession(
      `offline_${shop}`
    );

    if (!session) {
      console.log("❌ No offline session found for shop:", shop);
      return new Response("No session", { status: 200 });
    }

    // 3️⃣ Create GraphQL admin client manually
    const admin = new shopify.api.clients.Graphql({ session });

    // 4️⃣ Resolve variant from inventory item
    const inventoryItemGid = `gid://shopify/InventoryItem/${payload.inventory_item_id}`;

    const variantRes = await admin.query({
      data: {
        query: `
          query getInventoryItem($id: ID!) {
            inventoryItem(id: $id) {
              variant {
                id
                product {
                  id
                  title
                  handle
                }
              }
            }
          }
        `,
        variables: { id: inventoryItemGid },
      },
    });

    const variant =
      variantRes.body?.data?.inventoryItem?.variant;

    if (!variant) {
      console.log("❌ Variant not found");
      return new Response("OK", { status: 200 });
    }

    const variantId = variant.id.split("/").pop();
    const productId = variant.product.id.split("/").pop();

    console.log("🎯 VARIANT RESOLVED", {
      variantId,
      productTitle: variant.product.title,
    });

    // 5️⃣ Fetch CleverTap credentials
    const { accountId, passcode, region } =
      await getCleverTapConfig(admin);

    if (!accountId || !passcode || !region) {
      console.log("⚠️ CleverTap not configured");
      return new Response("OK", { status: 200 });
    }

    // 6️⃣ Fetch back_in_stock_request metaobjects
    const notifyRes = await admin.query({
      data: `
        query {
          metaobjects(type: "back_in_stock_request", first: 100) {
            nodes {
              id
              fields {
                key
                value
              }
            }
          }
        }
      `,
    });

    const allRequests =
      notifyRes.body?.data?.metaobjects?.nodes || [];

    const matchingRequests = allRequests.filter((req) => {
      const fields = Object.fromEntries(
        req.fields.map((f) => [f.key, f.value])
      );

      return (
        String(fields.variant_id) === String(variantId) &&
        fields.status === "pending"
      );
    });

    console.log(
      `🔔 MATCHING NOTIFY REQUESTS FOUND: ${matchingRequests.length}`
    );

    if (matchingRequests.length === 0) {
      return new Response("OK", { status: 200 });
    }

    // 7️⃣ Send CleverTap event & mark notified
    for (const req of matchingRequests) {
      const fields = Object.fromEntries(
        req.fields.map((f) => [f.key, f.value])
      );

      await sendCleverTapBackInStockEvent({
        region,
        accountId,
        passcode,
        email: fields.email,
        productId,
        variantId,
        productTitle: variant.product.title,
        productUrl: `https://${shop}/products/${variant.product.handle}`,
      });

      await admin.query({
        data: {
          query: `
            mutation markNotified($id: ID!) {
              metaobjectUpdate(
                id: $id,
                metaobject: {
                  fields: [{ key: "status", value: "notified" }]
                }
              ) {
                metaobject { id }
              }
            }
          `,
          variables: { id: req.id },
        },
      });
    }

    console.log("✅ All notifications processed");

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("❌ Inventory webhook error", err);
    return new Response("Webhook error", { status: 500 });
  }
};
