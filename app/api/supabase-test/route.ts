import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      { success: false, error: 'Missing Supabase environment variables' },
      { status: 400 },
    )
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data, error } = await supabase.from('ait_bot_state').select('*').limit(1)

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code ?? null },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      message: 'Connected to Supabase successfully!',
      sampleData: data,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Supabase error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
