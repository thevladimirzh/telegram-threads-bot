# language: en
Feature: Startup configuration
  The environment is validated once at startup: an invalid configuration fails
  with a typed error naming the offending variable and never with a crash (R40).
  The bot runs in polling mode by default and in webhook mode only when asked (AC9).

  @S10 @R40
  Scenario: A missing required environment variable fails startup with a typed error
    When the bot is started without "BOT_TOKEN"
    Then startup fails with a typed configuration error naming "BOT_TOKEN"

  @S11 @R40
  Scenario: ADMIN_IDS tolerates spaces and empty entries
    When the bot is started with "ADMIN_IDS" set to " 777 ,, 888 "
    Then user 777 and user 888 are recognized as global admins
    And user 999 is not recognized as a global admin

  @S12 @R40
  Scenario: A non-numeric ADMIN_IDS entry fails startup with a typed error
    When the bot is started with "ADMIN_IDS" set to "777, abc"
    Then startup fails with a typed configuration error naming "ADMIN_IDS"

  @S13 @R39
  Scenario: Webhook mode without webhook settings fails startup
    When the bot is started with "MODE" set to "webhook" and no "WEBHOOK_URL"
    Then startup fails with a typed configuration error explaining that webhook mode requires "WEBHOOK_URL" and "WEBHOOK_SECRET"

  @S14 @R39
  Scenario: Polling mode is the default and registers no webhook
    When the bot is started with "MODE" unset
    Then startup succeeds
    And no "setWebhook" call is made
