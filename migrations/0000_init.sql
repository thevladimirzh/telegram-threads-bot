CREATE TABLE "chats" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"username" text,
	"is_forum" integer DEFAULT 0 NOT NULL,
	"is_source" integer DEFAULT 0 NOT NULL,
	"is_threads" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"threads_chat_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"picked_chat_id" bigint,
	"preselected_chat_id" bigint,
	"dialog_message_id" bigint,
	"batch" jsonb NOT NULL,
	CONSTRAINT "drafts_threads_chat_id_author_id_pk" PRIMARY KEY("threads_chat_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "source_messages" (
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"date" bigint NOT NULL,
	"sender_id" bigint,
	"content" jsonb NOT NULL,
	"message_thread_id" bigint,
	"thread_id" bigint,
	CONSTRAINT "source_messages_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "thread_messages" (
	"thread_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"source_message_id" bigint,
	CONSTRAINT "thread_messages_thread_id_message_id_pk" PRIMARY KEY("thread_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"thread_id" bigint PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source_chat_id" bigint NOT NULL,
	"threads_chat_id" bigint NOT NULL,
	"root_message_id" bigint NOT NULL,
	"message_thread_id" bigint,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"locale" text
);
--> statement-breakpoint
CREATE INDEX "chats_source_idx" ON "chats" USING btree ("is_source");--> statement-breakpoint
CREATE INDEX "source_messages_match_idx" ON "source_messages" USING btree ("chat_id","date","sender_id");