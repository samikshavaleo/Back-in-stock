import { authenticate } from "../shopify.server";

/**
 * 🔐 Fetch CleverTap credentials for THIS store
 */
async function getCleverTapConfig(admin) {
  const res = await admin.graphql(`
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
  imageUrl,
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
          product_image: imageUrl,
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

    console.log("📦 INVENTORY WEBHOOK HIT", {
      shop: session.shop,
      inventory_item_id: payload.inventory_item_id,
      available: payload.available,
    });

    if (!payload.available || payload.available <= 0) {
      console.log("⏭️ Inventory still out of stock");
      return new Response("OK", { status: 200 });
    }

    console.log("✅ Stock is now available");

    /**
     * 1️⃣ Resolve Variant from Inventory Item
     */
    const inventoryItemGid = `gid://shopify/InventoryItem/${payload.inventory_item_id}`;

    const variantRes = await admin.graphql(
      `
      query getInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          variant {
            id
            image {
              url
            }
            product {
              id
              title
              handle
              featuredImage {
                url
              }
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

    // 🔥 Safe image fallback
    const imageUrl =
      variant.image?.url ||
      variant.product.featuredImage?.url ||
      null;

    console.log("🎯 VARIANT RESOLVED", {
      variantId,
      productTitle: variant.product.title,
      imageUrl,
    });

    /**
     * 2️⃣ Fetch CleverTap credentials
     */
    const { accountId, passcode, region } =
      await getCleverTapConfig(admin);

    if (!accountId || !passcode || !region) {
      console.log("⚠️ CleverTap not configured");
      return new Response("OK", { status: 200 });
    }

    /**
     * 3️⃣ Fetch pending back_in_stock_request metaobjects
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
    const allRequests =
      notifyJson?.data?.metaobjects?.nodes || [];

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
     * 4️⃣ Send CleverTap events & mark notified
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
        imageUrl,
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
