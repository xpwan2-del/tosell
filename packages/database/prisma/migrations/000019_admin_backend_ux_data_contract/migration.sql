ALTER TYPE "FulfillmentType" ADD VALUE IF NOT EXISTS 'code_pool';
ALTER TYPE "RightsCodeStatus" ADD VALUE IF NOT EXISTS 'locked';
ALTER TYPE "RightsCodeStatus" ADD VALUE IF NOT EXISTS 'revoked';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsCodeOwnerType') THEN
    CREATE TYPE "RightsCodeOwnerType" AS ENUM ('platform', 'agent');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailDeliveryScope') THEN
    CREATE TYPE "EmailDeliveryScope" AS ENUM ('codes', 'extract_link', 'codes_and_link');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailDeliveryStatus') THEN
    CREATE TYPE "EmailDeliveryStatus" AS ENUM ('pending', 'sent', 'provider_not_configured', 'failed', 'skipped_refunded');
  END IF;
END $$;
