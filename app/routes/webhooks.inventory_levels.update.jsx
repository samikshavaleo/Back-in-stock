import { authenticate } from "../shopify.server";

/**
 * 🔐 Fetch CleverTap credentials for THIS store (multi-store safe)
 * Required metafields:
 * namespace: clevertap
 * keys: account_id, passcode, region (eg: in1, us1, eu1)
 */
async function getCleverTapConfig(admin) {
  const res = await admin.graphql(`
    query {
      shop {
        accountId: metafield(
          namespace: "clevertap"
          key: "account_id"
        ) {
          value
        }
        passcode: metafield(
          namespace: "clevertap"
          key: "passcode"
        ) {
          value
        }
        region: metafield(
          namespace: "clevertap"
          key: "region"
        ) {
          value
        }
      }
    }
  `);

  const json = await res.json();

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
    const { payload, session, admin } =
      await authenticate.webhook(request);

    const { inventory_item_id, available } = payload;

    console.log("📦 INVENTORY WEBHOOK HIT", {
      shop: session.shop,
      inventory_item_id,
      available,
    });

    /**
     * 1️⃣ Exit early if still out of stock
     */
    if (!available || available <= 0) {
      console.log("⏭️ Inventory still out of stock");
      return new Response("OK", { status: 200 });
    }

    console.log("✅ Stock is now available");

    /**
     * 2️⃣ Resolve Variant from Inventory Item
     */
    const inventoryItemGid = `gid://shopify/InventoryItem/${inventory_item_id}`;

    const variantRes = await admin.graphql(
      `
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
      { variables: { id: inventoryItemGid } }
    );

    const variantJson = await variantRes.json();
    const variant = variantJson?.data?.inventoryItem?.variant;

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

    /**
     * 3️⃣ Fetch CleverTap credentials for this store
     */
    const { accountId, passcode, region } =
      await getCleverTapConfig(admin);

    if (!accountId || !passcode || !region) {
      console.log("⚠️ CleverTap not configured for this store");
      return new Response("OK", { status: 200 });
    }

    /**
     * 4️⃣ Fetch all back_in_stock_request metaobjects
     */
    const notifyRes = await admin.graphql(`
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
    `);

    const notifyJson = await notifyRes.json();
    const allRequests = notifyJson?.data?.metaobjects?.nodes || [];

    console.log(
      `🧪 Total back_in_stock_request fetched: ${allRequests.length}`
    );

    /**
     * 5️⃣ Filter pending requests for this variant
     */
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

    /**
     * 6️⃣ Send CleverTap events & mark notified
     */
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
        productUrl: `https://${session.shop}/products/${variant.product.handle}`,
      });

      await admin.graphql(
        `
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
        { variables: { id: req.id } }
      );
    }

    console.log("✅ All notifications processed");

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("❌ Inventory webhook error", err);
    return new Response("Webhook error", { status: 500 });
  }
};
