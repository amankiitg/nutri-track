export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      admins: {
        Row: {
          created_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      allowed_emails: {
        Row: {
          added_by: string | null;
          created_at: string;
          email: string;
        };
        Insert: {
          added_by?: string | null;
          created_at?: string;
          email: string;
        };
        Update: {
          added_by?: string | null;
          created_at?: string;
          email?: string;
        };
        Relationships: [];
      };
      llm_calls: {
        Row: {
          completion_tokens: number | null;
          created_at: string;
          id: string;
          latency_ms: number | null;
          model: string;
          prompt_tokens: number | null;
          status: string;
          user_id: string;
        };
        Insert: {
          completion_tokens?: number | null;
          created_at?: string;
          id?: string;
          latency_ms?: number | null;
          model: string;
          prompt_tokens?: number | null;
          status: string;
          user_id: string;
        };
        Update: {
          completion_tokens?: number | null;
          created_at?: string;
          id?: string;
          latency_ms?: number | null;
          model?: string;
          prompt_tokens?: number | null;
          status?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      meal_items: {
        Row: {
          calories: number;
          carbs_g: number;
          confidence: number | null;
          created_at: string;
          fat_g: number;
          fiber_g: number | null;
          grams: number | null;
          id: string;
          llm_raw: Json | null;
          meal_id: string;
          name: string;
          protein_g: number;
          quantity: number | null;
          sodium_mg: number | null;
          sugar_g: number | null;
          unit: string | null;
          user_edited: boolean;
        };
        Insert: {
          calories?: number;
          carbs_g?: number;
          confidence?: number | null;
          created_at?: string;
          fat_g?: number;
          fiber_g?: number | null;
          grams?: number | null;
          id?: string;
          llm_raw?: Json | null;
          meal_id: string;
          name: string;
          protein_g?: number;
          quantity?: number | null;
          sodium_mg?: number | null;
          sugar_g?: number | null;
          unit?: string | null;
          user_edited?: boolean;
        };
        Update: {
          calories?: number;
          carbs_g?: number;
          confidence?: number | null;
          created_at?: string;
          fat_g?: number;
          fiber_g?: number | null;
          grams?: number | null;
          id?: string;
          llm_raw?: Json | null;
          meal_id?: string;
          name?: string;
          protein_g?: number;
          quantity?: number | null;
          sodium_mg?: number | null;
          sugar_g?: number | null;
          unit?: string | null;
          user_edited?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "meal_items_meal_id_fkey";
            columns: ["meal_id"];
            isOneToOne: false;
            referencedRelation: "meals";
            referencedColumns: ["id"];
          },
        ];
      };
      meals: {
        Row: {
          created_at: string;
          deleted_at: string | null;
          eaten_at: string;
          id: string;
          idempotency_key: string | null;
          input_fingerprint: string;
          meal_type: Database["public"]["Enums"]["meal_type"];
          notes: string | null;
          photo_hashes: string[];
          photo_paths: string[];
          source: Database["public"]["Enums"]["meal_source"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          deleted_at?: string | null;
          eaten_at?: string;
          id?: string;
          idempotency_key?: string | null;
          input_fingerprint: string;
          meal_type: Database["public"]["Enums"]["meal_type"];
          notes?: string | null;
          photo_hashes?: string[];
          photo_paths?: string[];
          source: Database["public"]["Enums"]["meal_source"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          deleted_at?: string | null;
          eaten_at?: string;
          id?: string;
          idempotency_key?: string | null;
          input_fingerprint?: string;
          meal_type?: Database["public"]["Enums"]["meal_type"];
          notes?: string | null;
          photo_hashes?: string[];
          photo_paths?: string[];
          source?: Database["public"]["Enums"]["meal_source"];
          user_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          activity_level: Database["public"]["Enums"]["activity_level"];
          created_at: string;
          dietary_tags: string[];
          display_name: string;
          dob: string;
          goal: Database["public"]["Enums"]["goal_type"];
          height_cm: number;
          pace_kg_per_week: number | null;
          protein_g_per_kg: number;
          reminder_time: string | null;
          sex: Database["public"]["Enums"]["sex_type"];
          target_weight_kg: number | null;
          timezone: string;
          units: Database["public"]["Enums"]["unit_system"];
          updated_at: string;
          user_id: string;
          weight_kg: number;
        };
        Insert: {
          activity_level: Database["public"]["Enums"]["activity_level"];
          created_at?: string;
          dietary_tags?: string[];
          display_name: string;
          dob: string;
          goal: Database["public"]["Enums"]["goal_type"];
          height_cm: number;
          pace_kg_per_week?: number | null;
          protein_g_per_kg?: number;
          reminder_time?: string | null;
          sex: Database["public"]["Enums"]["sex_type"];
          target_weight_kg?: number | null;
          timezone?: string;
          units?: Database["public"]["Enums"]["unit_system"];
          updated_at?: string;
          user_id: string;
          weight_kg: number;
        };
        Update: {
          activity_level?: Database["public"]["Enums"]["activity_level"];
          created_at?: string;
          dietary_tags?: string[];
          display_name?: string;
          dob?: string;
          goal?: Database["public"]["Enums"]["goal_type"];
          height_cm?: number;
          pace_kg_per_week?: number | null;
          protein_g_per_kg?: number;
          reminder_time?: string | null;
          sex?: Database["public"]["Enums"]["sex_type"];
          target_weight_kg?: number | null;
          timezone?: string;
          units?: Database["public"]["Enums"]["unit_system"];
          updated_at?: string;
          user_id?: string;
          weight_kg?: number;
        };
        Relationships: [];
      };
      targets: {
        Row: {
          calories: number;
          carbs_g: number;
          created_at: string;
          effective_from: string;
          fat_g: number;
          fiber_g: number | null;
          id: string;
          protein_g: number;
          user_id: string;
        };
        Insert: {
          calories: number;
          carbs_g: number;
          created_at?: string;
          effective_from?: string;
          fat_g: number;
          fiber_g?: number | null;
          id?: string;
          protein_g: number;
          user_id: string;
        };
        Update: {
          calories?: number;
          carbs_g?: number;
          created_at?: string;
          effective_from?: string;
          fat_g?: number;
          fiber_g?: number | null;
          id?: string;
          protein_g?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      weight_log: {
        Row: {
          created_at: string;
          id: string;
          logged_on: string;
          source: Database["public"]["Enums"]["weight_source"];
          user_id: string;
          weight_kg: number;
        };
        Insert: {
          created_at?: string;
          id?: string;
          logged_on: string;
          source?: Database["public"]["Enums"]["weight_source"];
          user_id: string;
          weight_kg: number;
        };
        Update: {
          created_at?: string;
          id?: string;
          logged_on?: string;
          source?: Database["public"]["Enums"]["weight_source"];
          user_id?: string;
          weight_kg?: number;
        };
        Relationships: [];
      };
    };
    Views: {
      daily_summaries: {
        Row: {
          calories: number | null;
          carbs_g: number | null;
          fat_g: number | null;
          fiber_g: number | null;
          local_date: string | null;
          meal_count: number | null;
          protein_g: number | null;
          status: string | null;
          target_calories: number | null;
          target_carbs_g: number | null;
          target_fat_g: number | null;
          target_protein_g: number | null;
          user_id: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      calorie_status: {
        Args: { p_actual: number; p_target: number };
        Returns: string;
      };
      check_email_allowed: { Args: { _email: string }; Returns: boolean };
      daily_totals: {
        Args: { p_date: string };
        Returns: {
          calories: number;
          carbs_g: number;
          fat_g: number;
          fiber_g: number;
          local_date: string;
          meal_count: number;
          protein_g: number;
          remaining_calories: number;
          status: string;
          target_calories: number;
          target_carbs_g: number;
          target_fat_g: number;
          target_protein_g: number;
        }[];
      };
      is_admin: { Args: never; Returns: boolean };
      is_email_allowed: { Args: never; Returns: boolean };
      meals_for_day: { Args: { p_date: string }; Returns: Json };
      save_meal: { Args: { _items: Json; _meal: Json }; Returns: Json };
      target_on: {
        Args: { p_date: string };
        Returns: {
          calories: number;
          carbs_g: number;
          created_at: string;
          effective_from: string;
          fat_g: number;
          fiber_g: number | null;
          id: string;
          protein_g: number;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "targets";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      trailing_days: {
        Args: { p_days?: number; p_end_date: string };
        Returns: {
          calories: number;
          carbs_g: number;
          day_offset: number;
          fat_g: number;
          local_date: string;
          meal_count: number;
          protein_g: number;
          status: string;
          target_calories: number;
          target_protein_g: number;
        }[];
      };
      week_verdict: {
        Args: { p_days?: number; p_end_date: string };
        Returns: {
          avg_calories: number;
          avg_protein_g: number;
          avg_target_calories: number;
          avg_target_protein_g: number;
          days_judged: number;
          days_logged: number;
          days_on_track: number;
          verdict: string;
          window_days: number;
        }[];
      };
    };
    Enums: {
      activity_level:
        "sedentary" | "lightly_active" | "moderately_active" | "very_active" | "extra_active";
      goal_type: "lose" | "maintain" | "gain";
      meal_source: "photo" | "voice" | "text";
      meal_type: "breakfast" | "lunch" | "dinner" | "snack";
      sex_type: "male" | "female";
      unit_system: "metric" | "imperial";
      weight_source: "manual" | "import";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      activity_level: [
        "sedentary",
        "lightly_active",
        "moderately_active",
        "very_active",
        "extra_active",
      ],
      goal_type: ["lose", "maintain", "gain"],
      meal_source: ["photo", "voice", "text"],
      meal_type: ["breakfast", "lunch", "dinner", "snack"],
      sex_type: ["male", "female"],
      unit_system: ["metric", "imperial"],
      weight_source: ["manual", "import"],
    },
  },
} as const;
