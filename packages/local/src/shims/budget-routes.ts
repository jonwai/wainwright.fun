/**
 * Stands in for packages/infra/lambda/budget-routes.ts in the home-network build. Only the
 * snack_stock reward limit uses it (no reward does today). Snack stock is not wired up locally,
 * so such a reward reads as "none left" and a redemption cannot consume a portion.
 */
export interface WainsburysProduct {
  productSlug: string;
  portionsLeft: number;
}

export async function fetchSnackProducts(): Promise<WainsburysProduct[]> {
  return [];
}

export async function consumeWainsburysPortion(_productSlug: string): Promise<{ error: string }> {
  throw new Error("Snack-stock rewards are not available on the home network");
}
