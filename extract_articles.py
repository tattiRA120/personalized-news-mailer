import json

def extract_articles_by_input(file_path):
    articles = []
    with open(file_path, 'r') as f:
        for line in f:
            try:
                data = json.loads(line)
                custom_id_str = data.get('custom_id')
                input_text = data.get('body', {}).get('input')
                if custom_id_str and input_text:
                    custom_id_json = json.loads(custom_id_str)
                    article_id = custom_id_json.get('articleId')
                    articles.append({
                        'articleId': article_id,
                        'input': input_text
                    })
            except json.JSONDecodeError:
                print(f"Skipping malformed JSON line: {line.strip()}")
    return articles

file1_path = 'archive/articles_chunk0_1750597260970.jsonl'
file2_path = 'archive/articles_chunk0_1750683623735.jsonl'

articles1 = extract_articles_by_input(file1_path)
articles2 = extract_articles_by_input(file2_path)

# inputの内容を比較して重複する記事を見つける
duplicate_articles = []
for article1 in articles1:
    for article2 in articles2:
        if article1['input'] == article2['input'] and article1['articleId'] != article2['articleId']:
            duplicate_articles.append({
                'article1_id': article1['articleId'],
                'article2_id': article2['articleId'],
                'input': article1['input']
            })

if duplicate_articles:
    print("重複している記事が見つかりました (inputの内容が同じでarticleIdが異なる):")
    for dup_article in duplicate_articles:
        print(f"  Article 1 ID: {dup_article['article1_id']}")
        print(f"  Article 2 ID: {dup_article['article2_id']}")
        print(f"  Input: {dup_article['input']}")
        print("-" * 20)
else:
    print("重複している記事は見つかりませんでした。")
