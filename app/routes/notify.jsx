import { authenticate } from "../shopify.server";

export async function action({ request }) {
  console.log("🔥 /notify route HIT");

  try {
    const body = await request.json();
    const { email, product_id, variant_id } = body;

    if (!email || !product_id || !variant_id) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ✅ CORRECT auth for App Proxy
    const { admin } = await authenticate.public.appProxy(request);

    const mutation = `
      mutation CreateBackInStockRequest($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      metaobject: {
        type: "back_in_stock_request",
        fields: [
          { key: "email", value: email },
          { key: "product_id", value: product_id.toString() },
          { key: "variant_id", value: variant_id.toString() },
          { key: "status", value: "pending" },
          {
            key: "created_at",
            value: new Date().toISOString().split("T")[0],
          },
        ],
      },
    };

    const response = await admin.graphql(mutation, { variables });
    const result = await response.json();

    const errors = result.data?.metaobjectCreate?.userErrors;
    if (errors?.length) {
      return new Response(JSON.stringify({ errors }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Notify error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
