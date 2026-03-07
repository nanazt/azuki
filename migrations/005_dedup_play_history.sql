-- play_history 중복 제거: (track_id, user_id) 기준 최신 1건만 유지
DELETE FROM play_history
WHERE id NOT IN (
    SELECT MAX(id) FROM play_history GROUP BY track_id, user_id
);
