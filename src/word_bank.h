#pragma once
// 词库：从 CSV 加载单词，或使用代码内置的兜底词库。
// 数据格式：英文|音标|词性.释义/释义;词性.释义|等级|近义词释义/近义词释义（第 5 字段可选）
#include <string>
#include <vector>

// 一个词性下的若干释义
struct Sense {
    std::string pos;                    // 词性缩写：n / v / vt / vi / adj / adv / prep ...
    std::vector<std::string> meanings;  // 该词性下的释义列表
};

struct Word {
    std::string english;
    std::string phonetic;               // 音标（IPA）
    std::vector<Sense> senses;          // 一个词可含多个词性，每个词性多个释义
    std::vector<std::string> levels;    // 可属多个等级：cet4 / cet6 / kaoyan / ielts / toefl / gre
    std::vector<std::string> synonyms;  // 第 5 字段：近义词释义（选择题干扰项，可为空）

    // 是否属于某个等级
    bool hasLevel(const std::string& l) const {
        for (const auto& x : levels) if (x == l) return true;
        return false;
    }

    // 第一个释义（选择题选项用）
    std::string firstMeaning() const {
        if (senses.empty() || senses[0].meanings.empty()) return "";
        return senses[0].meanings[0];
    }

    // 仅中文释义（按词性分组）：如 "跑/经营；跑步"（用于题干与判分比对）
    std::string chineseOnly() const {
        std::string s;
        for (const auto& se : senses) {
            if (!s.empty()) s += ";";
            for (size_t i = 0; i < se.meanings.size(); ++i) {
                if (i) s += "/";
                s += se.meanings[i];
            }
        }
        return s;
    }

    // 词典式展示（含词性缩写）：如 "n. 苹果" 或 "v. 跑/经营；n. 跑步"
    std::string display() const {
        std::string s;
        for (const auto& se : senses) {
            if (!s.empty()) s += ";";
            s += se.pos + ". ";
            for (size_t i = 0; i < se.meanings.size(); ++i) {
                if (i) s += "/";
                s += se.meanings[i];
            }
        }
        return s;
    }
};

class WordBank {
public:
    // 从 CSV 文件加载。成功且非空返回 true；失败或为空返回 false。
    bool loadFromFile(const std::string& path);
    // 加载代码内置的兜底词库（保证没有 CSV 也能跑）。
    void loadDefaults();

    size_t size() const { return words_.size(); }
    const std::vector<Word>& all() const { return words_; }
    std::vector<Word> wordsByLevel(const std::string& level) const;

private:
    std::vector<Word> words_;
    void parse(const std::string& text);
};
