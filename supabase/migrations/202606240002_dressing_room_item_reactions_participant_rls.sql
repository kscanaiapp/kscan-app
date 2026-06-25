-- Dressing Room item emoji reactions - participant-aware RLS restore.
-- Forward-only migration.
--
-- Restores shared emoji collaboration after owner-only hardening.
-- Public preview remains read-only and does not receive raw anon table access.
--
-- Cross-domain dependency note:
-- This migration currently reuses public.can_access_room_messages(room_id)
-- as the owner-or-participant room-access helper. A later cleanup should rename
-- or replace it with a generic can_access_dressing_room(room_id) helper if
-- message-specific logic is ever added.

ALTER TABLE public.dressing_room_item_reactions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS dressing_room_item_reactions_item_id_idx
ON public.dressing_room_item_reactions (item_id);

DROP POLICY IF EXISTS "Users can select own dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Users can insert own dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Users can update own dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Users can delete own dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Room participants can select dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Room participants can insert dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Room participants can update dressing room item reactions"
ON public.dressing_room_item_reactions;

DROP POLICY IF EXISTS "Room participants can delete dressing room item reactions"
ON public.dressing_room_item_reactions;

CREATE POLICY "Room participants can select dressing room item reactions"
ON public.dressing_room_item_reactions
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.dressing_room_items dri
    WHERE dri.id = dressing_room_item_reactions.item_id
      AND public.can_access_room_messages(dri.dressing_room_id)
  )
);

CREATE POLICY "Room participants can insert dressing room item reactions"
ON public.dressing_room_item_reactions
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.dressing_room_items dri
    WHERE dri.id = dressing_room_item_reactions.item_id
      AND public.can_access_room_messages(dri.dressing_room_id)
  )
);

CREATE POLICY "Room participants can update dressing room item reactions"
ON public.dressing_room_item_reactions
FOR UPDATE
TO authenticated
USING (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.dressing_room_items dri
    WHERE dri.id = dressing_room_item_reactions.item_id
      AND public.can_access_room_messages(dri.dressing_room_id)
  )
)
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.dressing_room_items dri
    WHERE dri.id = dressing_room_item_reactions.item_id
      AND public.can_access_room_messages(dri.dressing_room_id)
  )
);

CREATE POLICY "Room participants can delete dressing room item reactions"
ON public.dressing_room_item_reactions
FOR DELETE
TO authenticated
USING (
  user_id = auth.uid()
);
