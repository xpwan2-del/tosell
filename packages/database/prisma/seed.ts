import { PrismaClient } from "@prisma/client";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { virtualCatalogProducts, virtualShopSeed } from "../src/virtual-catalog.js";

const prisma = new PrismaClient();

type SeedMerchant = {
  merchantNo: string;
  tier: "first_tier" | "second_tier" | "third_tier";
  name: string;
  phone: string;
  username: string;
  shopNo: string;
};

const seedMerchants: SeedMerchant[] = [
  { merchantNo: "MER000001", tier: "first_tier", name: "M1 开发商户", phone: "13800000001", username: "m1", shopNo: "SHOP000101" },
  { merchantNo: "MER000002", tier: "second_tier", name: "M2 开发商户", phone: "13800000002", username: "m2", shopNo: "SHOP000102" },
  { merchantNo: "MER000003", tier: "third_tier", name: "M3 开发商户", phone: "13800000003", username: "m3", shopNo: "SHOP000103" }
];

function paymentCredentialKey() {
  const source = process.env.PAYMENT_CREDENTIAL_SECRET
    ?? process.env.AUTH_TOKEN_SECRET
    ?? process.env.ADMIN_TOKEN_SECRET
    ?? process.env.JWT_SECRET
    ?? "tosell-local-development-payment-credential-secret";
  return createHash("sha256").update(source).digest();
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function encryptPaymentCredentialBundle(bundle: Record<string, string | undefined>) {
  const clean = Object.fromEntries(Object.entries(bundle).filter(([, value]) => typeof value === "string" && value.length > 0));
  if (Object.keys(clean).length === 0) return undefined;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", paymentCredentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(clean), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes256gcm:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

async function upsertMerchantWithShop(input: SeedMerchant, now: Date) {
  const merchant = await prisma.merchant.upsert({
    where: { merchantNo: input.merchantNo },
    update: {
      tier: input.tier,
      name: input.name,
      contactPhone: input.phone,
      status: "active",
      depositStatus: "paid",
      approvedAt: now
    },
    create: {
      merchantNo: input.merchantNo,
      tier: input.tier,
      name: input.name,
      contactPhone: input.phone,
      status: "active",
      depositStatus: "paid",
      creationSource: input.tier === "first_tier" ? "admin_manual" : "invite_application",
      initialAccountStatus: "delivered",
      approvedAt: now
    }
  });

  await prisma.merchantAccount.upsert({
    where: { username: input.username },
    update: {
      merchantId: merchant.id,
      phone: input.phone,
      status: "active",
      initialDeliveryStatus: "delivered",
      mustChangePassword: false
    },
    create: {
      merchantId: merchant.id,
      username: input.username,
      phone: input.phone,
      passwordHash: `dev-password-${input.username}`,
      status: "active",
      initialDeliveryStatus: "delivered",
      mustChangePassword: false
    }
  });

  const shop = await prisma.shop.upsert({
    where: { shopNo: input.shopNo },
    update: {
      ownerType: "merchant",
      merchantId: merchant.id,
      name: `${input.name}小店`,
      announcement: virtualShopSeed.announcement,
      customerServiceWechat: virtualShopSeed.customerServiceWechat,
      customerServiceQrUrl: `https://example.test/qr-${input.username}.png`,
      customerServiceQq: `8000${input.username}`,
      customerServiceNote: "开发验收客服资料",
      themeColor: virtualShopSeed.themeColor,
      bannerUrl: virtualShopSeed.bannerUrl,
      shareTitle: `${input.name}小店`,
      status: "open"
    },
    create: {
      ownerType: "merchant",
      merchantId: merchant.id,
      shopNo: input.shopNo,
      name: `${input.name}小店`,
      announcement: virtualShopSeed.announcement,
      customerServiceWechat: virtualShopSeed.customerServiceWechat,
      customerServiceQrUrl: `https://example.test/qr-${input.username}.png`,
      customerServiceQq: `8000${input.username}`,
      customerServiceNote: "开发验收客服资料",
      themeColor: virtualShopSeed.themeColor,
      bannerUrl: virtualShopSeed.bannerUrl,
      shareTitle: `${input.name}小店`,
      sharePath: `/s/${input.shopNo}`,
      status: "open"
    }
  });

  await prisma.depositAccount.upsert({
    where: { merchantId: merchant.id },
    update: {
      requiredAmountCents: 50_000n,
      availableAmountCents: 50_000n,
      status: "paid"
    },
    create: {
      merchantId: merchant.id,
      requiredAmountCents: 50_000n,
      availableAmountCents: 50_000n,
      status: "paid"
    }
  });

  await prisma.collectionPaymentConfig.upsert({
    where: { configNo: `PAYCFG_${input.username.toUpperCase()}_PERSONAL_ALIPAY` },
    update: { status: "active", isDefault: true, enabledAt: now },
    create: {
      configNo: `PAYCFG_${input.username.toUpperCase()}_PERSONAL_ALIPAY`,
      ownerType: "merchant",
      ownerMerchantId: merchant.id,
      shopId: shop.id,
      provider: "alipay_personal",
      confirmMode: "manual_confirm",
      status: "active",
      isDefault: true,
      enabledAt: now,
      displayName: `${input.name}个人支付宝`,
      qrUrl: `https://example.test/pay/${input.username}-alipay.png`,
      accountMasked: `${input.username}***pay`,
      credentialStatus: "not_configured",
      idempotencyKey: `seed:paycfg:${input.username}:personal-alipay`
    }
  });

  return { merchant, shop };
}

async function upsertSeedMerchantRelation(input: {
  issuerMerchantId: string;
  childMerchantId: string;
  childTier: "second_tier" | "third_tier";
  code: string;
  now: Date;
}) {
  const invite = await prisma.merchantInviteCode.upsert({
    where: { idempotencyKey: `seed:merchant-invite:${input.code}` },
    update: {
      issuerMerchantId: input.issuerMerchantId,
      tier: input.childTier,
      maxUses: 10,
      usedCount: 1,
      status: "approved"
    },
    create: {
      codeHash: hashSecret(input.code),
      issuerMerchantId: input.issuerMerchantId,
      tier: input.childTier,
      maxUses: 10,
      usedCount: 1,
      status: "approved",
      idempotencyKey: `seed:merchant-invite:${input.code}`
    }
  });

  await prisma.merchantApplication.upsert({
    where: { idempotencyKey: `seed:merchant-application:${input.code}` },
    update: {
      merchantId: input.childMerchantId,
      inviteCodeId: invite.id,
      tier: input.childTier,
      status: "approved",
      reviewedAt: input.now
    },
    create: {
      merchantId: input.childMerchantId,
      inviteCodeId: invite.id,
      tier: input.childTier,
      identityInfoJson: { source: "seed", relation: input.code },
      contactInfoJson: { source: "seed" },
      status: "approved",
      reviewedAt: input.now,
      idempotencyKey: `seed:merchant-application:${input.code}`
    }
  });
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed production. Production data must be created through admin workflows.");
  }

  const now = new Date();
  const user = await prisma.user.upsert({
    where: { openid: "dev_openid_user_001" },
    update: { phone: "13800000000" },
    create: {
      openid: "dev_openid_user_001",
      unionid: "dev_unionid_user_001",
      phone: "13800000000"
    }
  });

  const platformShop = await prisma.shop.upsert({
    where: { shopNo: "SHOP000001" },
    update: {
      ownerType: "platform",
      merchantId: null,
      name: "ToSell 平台主店",
      announcement: "平台自营商品与平台收款通道验收店铺。",
      customerServiceWechat: "platform_service",
      customerServiceQrUrl: "https://example.test/qr-platform.png",
      customerServiceQq: "800000",
      customerServiceNote: "平台主店开发验收客服资料",
      themeColor: virtualShopSeed.themeColor,
      bannerUrl: virtualShopSeed.bannerUrl,
      shareTitle: "ToSell 平台主店",
      status: "open"
    },
    create: {
      ownerType: "platform",
      merchantId: null,
      shopNo: "SHOP000001",
      name: "ToSell 平台主店",
      announcement: "平台自营商品与平台收款通道验收店铺。",
      customerServiceWechat: "platform_service",
      customerServiceQrUrl: "https://example.test/qr-platform.png",
      customerServiceQq: "800000",
      customerServiceNote: "平台主店开发验收客服资料",
      themeColor: virtualShopSeed.themeColor,
      bannerUrl: virtualShopSeed.bannerUrl,
      shareTitle: "ToSell 平台主店",
      sharePath: "/s/SHOP000001",
      status: "open"
    }
  });

  const merchantFixtures = [];
  for (const merchantSeed of seedMerchants) {
    merchantFixtures.push(await upsertMerchantWithShop(merchantSeed, now));
  }
  await upsertSeedMerchantRelation({
    issuerMerchantId: merchantFixtures[0].merchant.id,
    childMerchantId: merchantFixtures[1].merchant.id,
    childTier: "second_tier",
    code: "seed-m1-to-m2",
    now
  });
  await upsertSeedMerchantRelation({
    issuerMerchantId: merchantFixtures[1].merchant.id,
    childMerchantId: merchantFixtures[2].merchant.id,
    childTier: "third_tier",
    code: "seed-m2-to-m3",
    now
  });

  await prisma.userWallet.upsert({
    where: { userId: user.id },
    update: { availableBalanceCents: 20_000n, totalRechargeCents: 20_000n, status: "active" },
    create: {
      userId: user.id,
      walletNo: "WALLET000001",
      availableBalanceCents: 20_000n,
      totalRechargeCents: 20_000n,
      status: "active"
    }
  });

  const listingIdsByShop = new Map<string, string[]>();
  for (const fixture of merchantFixtures) {
    listingIdsByShop.set(fixture.shop.id, []);
  }

  for (const item of virtualCatalogProducts) {
    const fulfillmentType = item.fulfillmentMode === "code_pool" ? "code_pool" : "manual";
    const product = await prisma.platformProduct.upsert({
      where: { productNo: item.productNo },
      update: {
        name: item.name,
        categoryName: item.category,
        tagsJson: item.tags,
        imageUrl: item.imageUrl,
        specsJson: item.specs,
        detailSectionsJson: item.detailSections,
        stockCount: item.stockCount,
        soldCount: item.soldCount,
        detail: item.description,
        rightsDesc: item.subtitle,
        supplyPriceCents: item.supplyPriceCents,
        minSalePriceCents: item.minSalePriceCents,
        suggestedSalePriceCents: item.suggestedSalePriceCents,
        fulfillmentType,
        fulfillmentRuleJson: {
          mode: item.fulfillmentMode,
          usageGuide: item.usageGuide,
          ...(item.fulfillmentMode === "code_pool" ? { extractCodeRequired: true } : {})
        },
        afterSaleRuleJson: { refundBeforeFulfillment: true },
        status: "active"
      },
      create: {
        productNo: item.productNo,
        name: item.name,
        categoryName: item.category,
        tagsJson: item.tags,
        imageUrl: item.imageUrl,
        specsJson: item.specs,
        detailSectionsJson: item.detailSections,
        stockCount: item.stockCount,
        soldCount: item.soldCount,
        detail: item.description,
        rightsDesc: item.subtitle,
        supplyPriceCents: item.supplyPriceCents,
        minSalePriceCents: item.minSalePriceCents,
        suggestedSalePriceCents: item.suggestedSalePriceCents,
        fulfillmentType,
        fulfillmentRuleJson: {
          mode: item.fulfillmentMode,
          usageGuide: item.usageGuide,
          ...(item.fulfillmentMode === "code_pool" ? { extractCodeRequired: true } : {})
        },
        afterSaleRuleJson: { refundBeforeFulfillment: true },
        status: "active"
      }
    });

    await prisma.platformShopProduct.upsert({
      where: { shopId_platformProductId: { shopId: platformShop.id, platformProductId: product.id } },
      update: {
        salePriceCents: item.platformSalePriceCents ?? item.suggestedSalePriceCents,
        fulfillmentCostCents: item.fulfillmentCostCents ?? item.supplyPriceCents,
        status: "listed",
        listedAt: now
      },
      create: {
        shopId: platformShop.id,
        platformProductId: product.id,
        salePriceCents: item.platformSalePriceCents ?? item.suggestedSalePriceCents,
        fulfillmentCostCents: item.fulfillmentCostCents ?? item.supplyPriceCents,
        status: "listed",
        listedAt: now,
        idempotencyKey: `seed:platform-listing:${item.productNo}`
      }
    });

    for (const code of item.rightsCodes ?? []) {
      await prisma.rightsCode.upsert({
        where: {
          productId_codeCiphertext: {
            productId: product.id,
            codeCiphertext: `dev:platform:${code}`
          }
        },
        update: { status: "available" },
        create: {
          productId: product.id,
          codeCiphertext: `dev:platform:${code}`,
          batchNo: `seed-platform-${item.productNo.toLowerCase()}`,
          ownerType: "platform",
          shopId: platformShop.id,
          status: "available",
          importedById: "seed"
        }
      });
    }

    let upstreamListingId: string | undefined;
    for (const [index, fixture] of merchantFixtures.entries()) {
      const salePriceCents = item.merchantSalePriceCents + BigInt(index * 500);
      const sourceType = upstreamListingId ? "upstream_listing" : "platform_product";
      const listing = await prisma.merchantProductListing.upsert({
        where: { shopId_platformProductId: { shopId: fixture.shop.id, platformProductId: product.id } },
        update: {
          sourceType,
          upstreamListingId,
          salePriceCents,
          displayName: `${fixture.merchant.name} ${item.name}`,
          displaySubtitle: item.subtitle,
          displayDescription: item.description,
          displayUsageGuide: item.usageGuide,
          displayImageUrl: item.imageUrl,
          displayCategory: item.category,
          displayTagsJson: item.tags,
          displaySpecsJson: item.specs,
          displayDetailSectionsJson: item.detailSections,
          status: "listed",
          listedAt: now
        },
        create: {
          merchantId: fixture.merchant.id,
          shopId: fixture.shop.id,
          sourceType,
          platformProductId: product.id,
          upstreamListingId,
          salePriceCents,
          displayName: `${fixture.merchant.name} ${item.name}`,
          displaySubtitle: item.subtitle,
          displayDescription: item.description,
          displayUsageGuide: item.usageGuide,
          displayImageUrl: item.imageUrl,
          displayCategory: item.category,
          displayTagsJson: item.tags,
          displaySpecsJson: item.specs,
          displayDetailSectionsJson: item.detailSections,
          status: "listed",
          listedAt: now,
          idempotencyKey: `seed:merchant-listing:${fixture.merchant.merchantNo}:${item.productNo}`
        }
      });
      upstreamListingId = listing.id;
      listingIdsByShop.get(fixture.shop.id)?.push(listing.id);

      for (const code of item.rightsCodes ?? []) {
        await prisma.rightsCode.upsert({
          where: {
            merchantProductListingId_codeCiphertext: {
              merchantProductListingId: listing.id,
              codeCiphertext: `dev:${fixture.merchant.merchantNo}:${code}`
            }
          },
          update: { status: "available" },
          create: {
            merchantProductListingId: listing.id,
            codeCiphertext: `dev:${fixture.merchant.merchantNo}:${code}`,
            batchNo: `seed-${fixture.merchant.merchantNo.toLowerCase()}-${item.productNo.toLowerCase()}`,
            ownerType: "merchant",
            ownerMerchantId: fixture.merchant.id,
            shopId: fixture.shop.id,
            status: "available",
            importedById: "seed"
          }
        });
      }
    }
  }

  for (const fixture of merchantFixtures) {
    const review = await prisma.merchantProductReview.upsert({
      where: { idempotencyKey: `seed:merchant-owned-review:${fixture.merchant.merchantNo}` },
      update: { status: "approved", reviewedAt: now },
      create: {
        merchantId: fixture.merchant.id,
        shopId: fixture.shop.id,
        name: `${fixture.merchant.name} 自有虚拟服务`,
        detailJson: { description: "商户自有商品审核样例" },
        salePriceCents: 9_900n,
        afterSaleRuleJson: { refundBeforeFulfillment: true },
        fulfillmentRuleJson: {
          mode: fixture.merchant.tier === "second_tier" ? "manual" : "code_pool",
          ...(fixture.merchant.tier === "second_tier" ? {} : { extractCodeRequired: true })
        },
        fulfillmentType: fixture.merchant.tier === "second_tier" ? "manual" : "code_pool",
        status: "approved",
        reviewedById: "seed",
        reviewedAt: now,
        idempotencyKey: `seed:merchant-owned-review:${fixture.merchant.merchantNo}`
      }
    });

    await prisma.merchantProduct.upsert({
      where: { idempotencyKey: `seed:merchant-owned-product:${fixture.merchant.merchantNo}` },
      update: {
        salePriceCents: 9_900n,
        status: "listed",
        listedAt: now
      },
      create: {
        merchantId: fixture.merchant.id,
        shopId: fixture.shop.id,
        productType: "merchant_owned",
        ownProductReviewId: review.id,
        salePriceCents: 9_900n,
        status: "listed",
        listedAt: now,
        idempotencyKey: `seed:merchant-owned-product:${fixture.merchant.merchantNo}`
      }
    });

    await prisma.shopProductGroup.deleteMany({ where: { shopId: fixture.shop.id } });
    await prisma.shopProductGroup.create({
      data: {
        shopId: fixture.shop.id,
        name: "默认商品",
        sortOrder: 1,
        productListingIds: listingIdsByShop.get(fixture.shop.id) ?? []
      }
    });
  }

  await prisma.collectionPaymentConfig.upsert({
    where: { configNo: "PAYCFG_PLATFORM_BALANCE" },
    update: { status: "active", isDefault: false, enabledAt: now },
    create: {
      configNo: "PAYCFG_PLATFORM_BALANCE",
      ownerType: "platform",
      shopId: platformShop.id,
      provider: "balance",
      confirmMode: "balance_deduct",
      status: "active",
      isDefault: false,
      enabledAt: now,
      displayName: "余额支付",
      credentialStatus: "not_configured",
      idempotencyKey: "seed:paycfg:platform:balance"
    }
  });

  await prisma.collectionPaymentConfig.upsert({
    where: { configNo: "PAYCFG_PLATFORM_ALIPAY_PERSONAL" },
    update: { status: "active", isDefault: true, enabledAt: now },
    create: {
      configNo: "PAYCFG_PLATFORM_ALIPAY_PERSONAL",
      ownerType: "platform",
      shopId: platformShop.id,
      provider: "alipay_personal",
      confirmMode: "manual_confirm",
      status: "active",
      isDefault: true,
      enabledAt: now,
      displayName: "平台个人支付宝",
      qrUrl: "https://example.test/pay/platform-alipay.png",
      accountMasked: "plat***pay",
      credentialStatus: "not_configured",
      idempotencyKey: "seed:paycfg:platform:alipay-personal"
    }
  });

  await prisma.collectionPaymentConfig.upsert({
    where: { configNo: "PAYCFG_PLATFORM_EPAY" },
    update: {
      status: "active",
      isDefault: false,
      enabledAt: now,
      gatewayUrl: "https://xpay.uumua.com/xpay/epay/",
      apiMode: "submit",
      merchantNoMasked: "10***83",
      credentialCiphertext: encryptPaymentCredentialBundle({
        merchantNo: "10783",
        signingSecret: "dev-epay-signing-secret"
      }),
      credentialStatus: "configured"
    },
    create: {
      configNo: "PAYCFG_PLATFORM_EPAY",
      ownerType: "platform",
      shopId: platformShop.id,
      provider: "epay",
      confirmMode: "callback_query",
      status: "active",
      isDefault: false,
      enabledAt: now,
      displayName: "平台 e支付",
      merchantNoMasked: "10***83",
      gatewayUrl: "https://xpay.uumua.com/xpay/epay/",
      apiMode: "submit",
      credentialCiphertext: encryptPaymentCredentialBundle({
        merchantNo: "10783",
        signingSecret: "dev-epay-signing-secret"
      }),
      credentialStatus: "configured",
      idempotencyKey: "seed:paycfg:platform:epay"
    }
  });

  await prisma.platformServiceFeeConfig.upsert({
    where: { idempotencyKey: "seed:service-fee:default" },
    update: { enabled: true, feeBps: 50, status: "active" },
    create: {
      enabled: true,
      feeBps: 50,
      basisType: "final_sale_price",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      status: "active",
      idempotencyKey: "seed:service-fee:default"
    }
  });

  const coupon = await prisma.couponTemplate.upsert({
    where: { couponNo: "COUPON_REGISTER_001" },
    update: { status: "active" },
    create: {
      couponNo: "COUPON_REGISTER_001",
      name: "注册赠送优惠券",
      discountAmountCents: 500n,
      platformSubsidyCents: 500n,
      firstRegistrationOnly: true,
      status: "active",
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: new Date("2027-01-01T00:00:00.000Z"),
      idempotencyKey: "seed:coupon:register"
    }
  });

  await prisma.couponScope.upsert({
    where: { id: "seed_coupon_scope_all" },
    update: {},
    create: {
      id: "seed_coupon_scope_all",
      couponTemplateId: coupon.id,
      scopeType: "all_products"
    }
  });

  await prisma.auditLog.upsert({
    where: { idempotencyKey: "audit:seed:merchants-only" },
    update: {},
    create: {
      actorType: "system",
      actorId: "seed",
      action: "seed.merchants_only",
      targetType: "shop",
      targetId: platformShop.id,
      beforeJson: {},
      afterJson: { platformShopNo: platformShop.shopNo, merchantShopNos: merchantFixtures.map((fixture) => fixture.shop.shopNo) },
      reason: "development seed data",
      idempotencyKey: "audit:seed:merchants-only",
      requestId: "seed-merchants-only",
      ip: "127.0.0.1"
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
